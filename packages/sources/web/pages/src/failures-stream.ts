import { ClosedWorld } from '@zukhruf/snapshot-differential';

import {
  type CopyConfiguration,
  type SourceMessage,
  Stream,
  diffSnapshot,
  validateRecords,
} from '@eltjs/elt';

const properties = {
  inputUrl: {
    type: 'string',
    description: 'The chosen website, sitemap or feed; the partition key.',
  },
  url: {
    type: 'string',
    description:
      'A page that the crawl of the input would hand back and whose last visit failed.',
  },
} as const;

/** The stream of the pages of a web stream whose last visit failed, one row for each input and page: its dead-letter output. */
export function failuresStream(name: string) {
  return new Stream({
    name,
    jsonSchema: {
      type: 'object',
      description:
        "The pages of the web stream whose last visit failed, one row for each input and page: the stream's dead-letter output. A page leaves once a visit of it succeeds; a document that failed, such as a sitemap, is none. A reader that concludes from an absence behind the crawls stream waits for these pages one by one.",
      properties,
      required: Object.keys(properties),
    },
    primaryKey: ['inputUrl', 'url'],
    partitionKey: ['inputUrl'],
    // The rows of an input are the failures that its last crawl left, so only
    // a crawl that ran in the read replaces them.
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
}

/** The rows of one input whose crawl ended in this read: the pages that it left failed replace the rows of its last crawl. */
export async function* failureRecords(
  configuration: CopyConfiguration,
  state: unknown,
  inputUrl: string,
  failures: readonly string[],
  signal: AbortSignal | undefined,
): AsyncGenerator<SourceMessage> {
  yield* diffSnapshot(
    configuration,
    validateRecords(
      configuration.stream,
      failures.map((url) => ({ inputUrl, url })),
      'Web',
    ),
    state,
    { policy: new ClosedWorld(), signal },
  );
}
