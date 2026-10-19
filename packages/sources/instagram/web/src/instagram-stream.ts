import { rm } from 'node:fs/promises';

import {
  type CopyConfiguration,
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  type SourceMessage,
  Stream,
  type SyncMode,
  validateRecords,
} from '@workspace/elt';

import type { InstagramRun } from './instagram-run.ts';

// A date range a selection narrows posts to, as instants.
export type DateRange = {
  readonly startAt?: string;
  readonly endAt?: string;
};

// Whether an instant falls in the range: from its start, up to its end,
// which, as an import scope's, is exclusive.
export function within(
  { startAt, endAt }: DateRange,
  instant: string,
): boolean {
  return (
    (startAt === undefined || instant >= startAt) &&
    (endAt === undefined || instant < endAt)
  );
}

// What one stream's read of one profile, or of the session's account, gets.
export type ReadContext = {
  readonly run: InstagramRun;
  readonly state: unknown;
  // The profile a partitioned stream reads; null for the account's own.
  readonly profileId: string | null;
  readonly range: DateRange;
  // The copy the read is for.
  readonly configuration: CopyConfiguration;
  // The copy reads each record's file.
  readonly files: boolean;
  readonly signal: AbortSignal | undefined;
};

// An Instagram stream: its description, and how one run reads it.
export abstract class InstagramStream<P extends Properties> {
  abstract readonly name: string;
  abstract readonly jsonSchema: {
    readonly type: 'object';
    readonly description: string;
    readonly properties: P;
    readonly required: string[];
  };
  abstract readonly primaryKey: readonly string[];
  readonly partitionKey: readonly string[] | undefined = ['profileId'];
  // Most lists are longer than one run reads, so they are read only
  // incrementally, a part of the scan per run.
  readonly supportedSyncModes: readonly SyncMode[] = ['incremental'];
  readonly sourceDefinedCursor = true;
  readonly emitsDeletes = true;
  readonly supportsFileTransfer: true | undefined = undefined;
  readonly expiresBy: string | undefined = undefined;
  #stream?: Stream;

  describe(): Stream {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }

  abstract read(context: ReadContext): AsyncGenerator<SourceMessage>;

  protected validated(drafts: readonly RecordDraft<P>[]): SchemaRecord<P>[] {
    return validateRecords(this, [...drafts], 'Instagram');
  }

  // The JSON of a record's primary key values: how images are matched to
  // the records the diff emits.
  protected keyOf(record: unknown): string {
    if (typeof record !== 'object' || record === null)
      throw new TypeError(`Instagram ${this.name} record is not an object`);
    return JSON.stringify(
      this.primaryKey.map((field) => Reflect.get(record, field)),
    );
  }

  // Gives each record the diff emits its image, saved while the record is
  // read and removed once it is loaded: only new and changed records are
  // downloaded.
  protected async *withImages(
    messages: AsyncIterable<SourceMessage> | Iterable<SourceMessage>,
    images: ReadonlyMap<string, string>,
    { run, files, signal }: ReadContext,
  ): AsyncGenerator<SourceMessage> {
    for await (const message of messages) {
      if ('type' in message || !files) {
        yield message;
        continue;
      }
      const url = images.get(this.keyOf(message.data));
      const file = url === undefined ? null : await run.download(url, signal);
      yield { ...message, file };
      if (file !== null) await rm(file, { force: true });
    }
  }
}
