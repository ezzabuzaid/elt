import type { Reader, RevisitPolicy } from '@workspace/sdk-web-crawler';

import type { RecordExtractor } from './record-extractor.ts';

/** A configured stream of pages: the crawl's readers navigate, and the extractor turns each page into records. */
export class WebStream {
  readonly name: string;
  /** The record key within one input. */
  readonly primaryKey: readonly string[];
  readonly readers: readonly Reader<unknown, unknown>[];
  /** When an incremental crawl requests a known URL again; omitted, the crawler's AdaptiveRevisit. */
  readonly revisit: RevisitPolicy<unknown> | undefined;
  /** Pages to extract; omitted, every page the crawl finds. */
  readonly include: readonly URLPattern[] | undefined;
  readonly extractor: RecordExtractor;
  constructor(options: {
    name: string;
    primaryKey: readonly string[];
    readers: readonly Reader<unknown, unknown>[];
    revisit?: RevisitPolicy<unknown>;
    include?: readonly URLPattern[];
    extractor: RecordExtractor;
  }) {
    this.name = options.name;
    this.primaryKey = options.primaryKey;
    this.readers = options.readers;
    this.revisit = options.revisit;
    this.include = options.include;
    this.extractor = options.extractor;
  }
}
