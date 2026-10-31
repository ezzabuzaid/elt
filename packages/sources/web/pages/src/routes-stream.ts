import { Coverage } from '@zukhruf/snapshot-differential';
import { z } from 'zod';

import {
  type CopyConfiguration,
  type SourceMessage,
  Stream,
  diffSnapshot,
  validateRecords,
} from '@workspace/elt';
import { type Route, routeHows } from '@workspace/sdk-web-crawler';

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

/** The stream of the routes that the crawls of a web stream find, one row for each listing and URL that it named. */
export function routesStream(name: string) {
  return new Stream({
    name,
    jsonSchema: {
      type: 'object',
      description:
        'Each URL that a listing of the crawl named, with how and with what text. A listing that is read again completely replaces its rows; an incomplete read only adds rows, and a listing that is not read keeps them.',
      properties,
      required: Object.keys(properties),
    },
    primaryKey: ['inputUrl', 'listingUrl', 'url'],
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
 * The last complete read of a listing replaces its rows; an incomplete read
 * adds its routes and deletes none, and the rows of every other listing stay.
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
  const read = new Map<
    string,
    { complete: boolean; routes: Map<string, Route> }
  >();
  for (const { listingUrl, complete, routes } of groups) {
    const named = new Map(routes.map((route) => [route.url, route]));
    const before = read.get(listingUrl);
    if (complete || before === undefined)
      read.set(listingUrl, { complete, routes: named });
    else for (const [url, route] of named) before.routes.set(url, route);
  }
  for await (const message of diffSnapshot(
    configuration,
    validateRecords(
      configuration.stream,
      [...read].flatMap(([listingUrl, { routes }]) =>
        [...routes.values()].map(({ url, how, text }) => ({
          inputUrl,
          listingUrl,
          url,
          how,
          text,
        })),
      ),
      'Web',
    ),
    state === null ? null : routesState.parse(state).diff,
    {
      policy: new Coverage(
        ({ key }) => read.get(String(key.listingUrl))?.complete === true,
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
