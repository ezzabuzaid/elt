import { Coverage } from '@zukhruf/snapshot-differential';
import { z } from 'zod';

import {
  type CopyConfiguration,
  type SourceMessage,
  Stream,
  diffSnapshot,
  validateRecords,
} from '@eltjs/elt';
import { type Route, routeHows } from '@eltjs/sdk-web-crawler';

import type { Outbox } from './web-scan.ts';

const properties = {
  inputUrl: {
    type: 'string',
    description: 'The chosen website, sitemap or feed; the partition key.',
  },
  listingUrl: {
    type: 'string',
    description:
      "The response that named the URL, by its final URL, as a page record's listingUrl; for a redirect, the URL that was requested.",
  },
  reader: {
    type: 'integer',
    minimum: 0,
    description:
      "The position, among the web stream's readers, of the reader that named the URL; for a redirect, which the crawl follows itself, the number of readers.",
  },
  position: {
    type: 'integer',
    minimum: 0,
    description:
      'The position of the route among the URLs that the reader named in the listing, from 0: a listing that links one URL twice gives a route for each link.',
  },
  url: {
    type: 'string',
    description:
      'The URL that the listing named, whether the crawl found it there first or not.',
  },
  how: {
    type: 'string',
    enum: routeHows,
    description:
      "How the listing named the URL, such as 'list-item', 'link', 'robots-sitemap', 'sitemap-entry', 'feed-item' or 'redirect'.",
  },
  text: {
    type: ['string', 'null'],
    description:
      'The anchor text of the link or the list item, or the title of the feed item; null when the listing gives none, as a sitemap entry.',
  },
} as const;

/**
 * The stream of the routes that the crawls of a web stream find, one row for
 * each place where a reader found a URL in a listing. A page does not keep
 * its links unique, so the key is the listing, the reader and the position,
 * and the URL is a column (ADR 0022 of elt).
 */
export function routesStream(name: string) {
  return new Stream({
    name,
    jsonSchema: {
      type: 'object',
      description:
        'Each URL that a listing of the crawl named, at each place where a reader of the stream found it, with how and with what text. A listing that is read again replaces the rows of each reader that read it; the rows of a reader that skipped it, and of a listing that is not read, stay.',
      properties,
      required: Object.keys(properties),
    },
    primaryKey: ['inputUrl', 'listingUrl', 'reader', 'position'],
    partitionKey: ['inputUrl'],
    // Only the listings that a crawl reads replace their rows, so a full
    // refresh could not give the rows of the listings it did not read.
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
}

/** What a routes stream saves for one input: its diff, and the number of the first group of routes that it did not commit. */
export const routesState = z.object({
  diff: z.unknown(),
  undelivered: z.number().int().nonnegative(),
});

/**
 * The rows of the listings that the crawl of one input read, as one scan.
 * The last read of a listing that a reader read replaces that reader's rows;
 * a reader that skipped it keeps its rows, and the rows of every other
 * listing stay.
 */
export async function* routeRecords(
  configuration: CopyConfiguration,
  state: unknown,
  inputUrl: string,
  groups: Outbox,
  signal: AbortSignal | undefined,
): AsyncGenerator<SourceMessage> {
  const last = groups.at(-1);
  if (last === undefined) return;
  // Each listing's routes by the reader that named them. A redirect is named
  // by the crawl, as one reader after the stream's readers.
  const read = new Map<string, Map<number, readonly Route[]>>();
  for (const { listingUrl, readers, redirect } of groups) {
    const named = read.get(listingUrl) ?? new Map<number, readonly Route[]>();
    for (const [reader, routes] of readers.entries())
      if (routes !== null) named.set(reader, routes);
    named.set(
      readers.length,
      redirect === null ? [] : [{ url: redirect, how: 'redirect', text: null }],
    );
    read.set(listingUrl, named);
  }
  for await (const message of diffSnapshot(
    configuration,
    validateRecords(
      configuration.stream,
      [...read].flatMap(([listingUrl, named]) =>
        [...named].flatMap(([reader, routes]) =>
          routes.map(({ url, how, text }, position) => ({
            inputUrl,
            listingUrl,
            reader,
            position,
            url,
            how,
            text,
          })),
        ),
      ),
      'Web',
    ),
    state === null ? null : routesState.parse(state).diff,
    {
      policy: new Coverage(
        ({ key }) =>
          read.get(String(key.listingUrl))?.has(Number(key.reader)) === true,
      ),
      signal,
    },
  ))
    yield 'type' in message && message.type === 'STATE'
      ? {
          ...message,
          state: { diff: message.state, undelivered: last.seq + 1 },
        }
      : message;
}
