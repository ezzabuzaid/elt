import {
  type CopyConfiguration,
  type Partition,
  type Properties,
  type RecordMessage,
  type SourceMessage,
  Stream,
  type SyncMode,
  validateRecords,
} from '@workspace/elt';

import type { SearchConsoleScan } from './search-console-scan.ts';

const text = { type: 'string' } as const;
const id = { ...text, minLength: 1 };
const nullableText = { type: ['string', 'null'] } as const;
const integer = { type: 'integer' } as const;
const ordinal = { ...integer, minimum: 0 };
const nullableOrdinal = { type: ['integer', 'null'], minimum: 0 } as const;
const boolean = { type: 'boolean' } as const;
const metric = { type: 'number', minimum: 0 } as const;
// Feed reports omit position entirely, including on zero-traffic rows, so a
// missing rank is unknown rather than the best possible rank.
const nullableMetric = { type: ['number', 'null'], minimum: 0 } as const;
const nullableTimestamp = { ...nullableText, format: 'date-time' } as const;
const timestamp = { ...text, format: 'date-time' } as const;
const nullableInteger = { type: ['integer', 'null'] } as const;
// Search Console reports a PST calendar date, not an instant.
const date = { ...id, format: 'date' } as const;

export const searchConsoleFields = {
  text,
  id,
  nullableText,
  ordinal,
  nullableOrdinal,
  boolean,
  metric,
  nullableMetric,
  timestamp,
  nullableTimestamp,
  nullableInteger,
  date,
};

export const siteUrl = {
  ...id,
  description:
    'The Search Console property: sc-domain:<domain> for a domain property, or the URL prefix of a URL-prefix property.',
};

// What one stream is, apart from how it syncs: its family decides that.
export type StreamDefinition = {
  readonly name: string;
  // What one record is, its primary key, and when one is deleted.
  readonly description: string;
  readonly properties: Properties;
  readonly primaryKey: readonly string[];
  // Every stream but sites is read once per property, the partition every
  // row carries; sites is the grant's own list, the same for all of them.
  readonly partitionKey?: readonly string[];
};

/**
 * A Search Console stream: its description, and how one read of it turns
 * Google's answers into messages. Each family of streams that reads alike is
 * a subclass: the lists Google returns whole, the dated analytics that resume
 * from the last settled day, and the rolling inspections. Deletions come from
 * the source: incremental copies diff each read with the last, unless the
 * stream is rolling.
 */
export abstract class SearchConsoleStream {
  readonly stream: Stream;

  constructor(
    {
      name,
      description,
      properties,
      primaryKey,
      partitionKey,
    }: StreamDefinition,
    supportedSyncModes: readonly SyncMode[],
  ) {
    this.stream = new Stream({
      name,
      jsonSchema: {
        type: 'object',
        description,
        properties,
        required: Object.keys(properties),
      },
      primaryKey,
      supportedSyncModes,
      sourceDefinedCursor: true,
      emitsDeletes: true,
      partitionKey,
    });
  }

  abstract extract(
    configuration: CopyConfiguration,
    state: unknown,
    partition: Partition | null,
    scan: SearchConsoleScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage>;

  // The property a partitioned stream's read is for.
  protected siteUrl(partition: Partition | null): string {
    const siteUrl = partition?.siteUrl;
    if (typeof siteUrl !== 'string')
      throw new TypeError(
        `Search Console stream ${this.stream.name} is read per property`,
      );
    return siteUrl;
  }

  // A full refresh: every row, validated, as a record.
  protected *records(
    rows: readonly Record<string, unknown>[],
  ): Generator<RecordMessage> {
    for (const data of validateRecords(this.stream, rows, 'Search Console'))
      yield { stream: this.stream.name, data };
  }
}

// Google reports some instants to the second (2026-09-14T19:44:28Z); they
// load in the canonical millisecond form every other timestamp uses.
export function instant(value: string | undefined): string | null {
  return value === undefined ? null : new Date(value).toISOString();
}
