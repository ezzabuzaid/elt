import type { Got, Response } from 'got';

import type { Properties } from '@workspace/elt';

/** One crawl's extraction, opened with the crawl's HTTP client. */
export type ExtractorRun = {
  /** The Accept header for the pages the stream hands back, or null for the client's default. */
  readonly accept: string | null;
  read(
    response: Response,
    signal: AbortSignal,
  ): Promise<{
    /** Known before records are extracted, so an unchanged page skips extraction; null when other responses can change the output. */
    readonly fingerprint: string | null;
    records(): Promise<readonly Record<string, unknown>[]>;
  }>;
};

/** Turns a page the crawl hands back into the records of one stream. */
export abstract class RecordExtractor {
  /** JSON Schema properties of one record, without the page's provenance columns. */
  abstract readonly properties: Properties;
  abstract open(http: Got): ExtractorRun;
}
