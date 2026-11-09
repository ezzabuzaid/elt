import { z } from 'zod';

import { type CopyConfiguration, type SourceMessage, Stream } from '@eltjs/elt';

import type { CrawlEnd } from './web-scan.ts';

const properties = {
  inputUrl: {
    type: 'string',
    description: 'The chosen website, sitemap or feed; the partition key.',
  },
  complete: {
    type: 'boolean',
    description:
      'Whether the last crawl of the input reached its end: false while an expansion budget or a blocked host leaves pages for a later run, or when the crawl stopped. A failed page is due again later and does not keep it false.',
  },
  since: {
    type: 'string',
    format: 'date-time',
    description:
      'When the crawl that first gave this value of complete ended: every crawl of the input since then gave the same value.',
  },
} as const;

/** The stream of how the last crawl of each input of a web stream ended, one row for each input. */
export function crawlsStream(name: string) {
  return new Stream({
    name,
    jsonSchema: {
      type: 'object',
      description:
        'One row for each input of the web stream: whether its last crawl is complete, and since when. A reader that concludes from an absence, such as a page that no route reaches, waits for complete, as a stream processor waits for its watermark.',
      properties,
      required: Object.keys(properties),
    },
    primaryKey: ['inputUrl'],
    partitionKey: ['inputUrl'],
    // since lives on across runs only in the stream's state.
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: true,
  });
}

/** What a crawls stream saves for one input: its row as it last loaded. */
export const crawlsState = z.object({
  complete: z.boolean(),
  since: z.string(),
});

/** The row of one input whose crawl ended in this read, when it changed, and the state that keeps it. */
export async function* crawlRecords(
  configuration: CopyConfiguration,
  state: unknown,
  inputUrl: string,
  crawl: CrawlEnd,
): AsyncGenerator<SourceMessage> {
  const before = state === null ? null : crawlsState.parse(state);
  // A crawl that ends as the one before it did changes nothing.
  if (before?.complete === crawl.complete) return;
  const row = { complete: crawl.complete, since: crawl.at };
  const stream = configuration.stream.name;
  yield { stream, data: { inputUrl, ...row } };
  yield { type: 'STATE', stream, state: row };
}
