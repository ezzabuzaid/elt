import {
  type Properties,
  type RecordMessage,
  Stream,
  validateRecords,
} from '@workspace/elt';

import type { GoogleHealthScan } from './google-health-scan.ts';

export type StreamDefinition = {
  readonly name: string;
  // What one record is, its key, and how a change upstream reaches it.
  readonly description: string;
  readonly properties: Properties;
  readonly primaryKey?: readonly string[];
};

// Rows checked per call, so a long history streams instead of collecting.
const BATCH = 1000;

/**
 * A Google Health stream. Google keeps no change record a source can read:
 * most points carry no id or update time, and deletions reach only webhooks.
 * So every stream reloads whole on each run (full refresh, overwrite), and an
 * edit or deletion upstream shows after the next run. Each family that reads
 * alike is a subclass: a data type's points, their child lists, the daily
 * rollups, and the account.
 */
export abstract class GoogleHealthStream {
  readonly stream: Stream;

  constructor({ name, description, properties, primaryKey }: StreamDefinition) {
    this.stream = new Stream({
      name,
      jsonSchema: {
        type: 'object',
        description,
        properties,
        required: Object.keys(properties),
      },
      ...(primaryKey && { primaryKey }),
      supportedSyncModes: ['full_refresh'],
    });
  }

  abstract extract(
    scan: GoogleHealthScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<RecordMessage>;

  // Every row, checked against the stream's schema, as a record.
  protected async *records(
    rows:
      | AsyncIterable<Record<string, unknown>>
      | Iterable<Record<string, unknown>>,
  ): AsyncGenerator<RecordMessage> {
    let batch: Record<string, unknown>[] = [];
    for await (const row of rows) {
      batch.push(row);
      if (batch.length < BATCH) continue;
      yield* this.#checked(batch);
      batch = [];
    }
    yield* this.#checked(batch);
  }

  *#checked(rows: Record<string, unknown>[]): Generator<RecordMessage> {
    for (const data of validateRecords(this.stream, rows, 'Google Health'))
      yield { stream: this.stream.name, data };
  }
}
