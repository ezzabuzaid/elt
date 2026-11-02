import {
  ClosedWorld,
  type DeletionPolicy,
  Retention,
} from '@zukhruf/snapshot-differential';

import {
  type Properties,
  type RecordDraft,
  Stream,
  validateRecords,
} from '@workspace/elt';

import type { ChromiumScan, ChromiumStore } from './chromium-scan.ts';

export const chromiumFields = {
  profileId: {
    type: 'string',
    minLength: 1,
    description:
      'The folder of the profile, such as Default or Profile 1; refers to profiles.id within this source.',
  },
  text: { type: 'string' },
  nullableText: { type: ['string', 'null'] },
  integer: { type: 'integer' },
  nullableInteger: { type: ['integer', 'null'] },
  ordinal: { type: 'integer', minimum: 0 },
  boolean: { type: 'boolean' },
  // Chromium keeps times to the microsecond.
  instant: { type: ['string', 'null'], format: 'date-time', precision: 6 },
} as const;

const expiresAt = {
  type: 'string',
  format: 'date-time',
  description:
    'When the browser removes this record by age, as Chromium does: a visit 90 days after it happened, the visit of a frame that loaded on its own 3 days sooner, and a URL and its search terms with their last visit, 87 days after it at the soonest. A record that has no time is past it.',
} as const;

// What the source needs from any stream, whatever its record type.
export type ChromiumReader = {
  readonly name: string;
  readonly store: ChromiumStore;
  describe(): Stream;
  read(stream: Stream, scan: ChromiumScan): Iterable<Record<string, unknown>>;
  policy(scan: ChromiumScan): DeletionPolicy;
};

// A stream of one profile store: its description, and how its records come
// out of a run's scan. Every read is the whole store, so incremental copies
// diff snapshots. A stream that the browser expires, for a browser that
// removes old history, has expiresAt and keeps a record that vanished past
// it.
export abstract class ChromiumStream<P extends Properties, Row> {
  abstract readonly name: string;
  abstract readonly store: ChromiumStore;
  abstract readonly description: string;
  abstract readonly properties: P;
  abstract readonly primaryKey: readonly string[];
  // When the browser removes a row by age; none for a store the browser
  // keeps whole.
  readonly #expiry: ((row: Row) => string | null) | undefined;

  constructor(expiry?: (row: Row) => string | null) {
    this.#expiry = expiry;
  }

  // A new Stream each call: the source asks once, for its catalog.
  describe(): Stream {
    const expires = this.#expiry !== undefined;
    const properties = expires
      ? { ...this.properties, expiresAt }
      : this.properties;
    return new Stream({
      name: this.name,
      jsonSchema: {
        type: 'object',
        description: this.description,
        properties,
        required: Object.keys(properties),
      },
      primaryKey: this.primaryKey,
      supportedSyncModes: ['full_refresh', 'incremental'],
      sourceDefinedCursor: true,
      emitsDeletes: true,
      ...(expires ? { expiresBy: 'expiresAt' } : {}),
    });
  }

  // One record at a time, so a pass never holds a whole store's rows.
  *read(
    stream: Stream,
    scan: ChromiumScan,
  ): Generator<Record<string, unknown>> {
    const expiry = this.#expiry;
    for (const row of this.rows(scan)) {
      const draft = this.record(row);
      yield* validateRecords(
        stream,
        [expiry === undefined ? draft : { ...draft, expiresAt: expiry(row) }],
        'Chromium',
      );
    }
  }

  // The browser removed what expired before the scan began.
  policy(scan: ChromiumScan): DeletionPolicy {
    return this.#expiry === undefined
      ? new ClosedWorld()
      : new Retention(scan.startedAt);
  }

  protected abstract rows(scan: ChromiumScan): Iterable<Row>;

  protected abstract record(row: Row): RecordDraft<P>;
}
