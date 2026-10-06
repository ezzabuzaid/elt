import {
  type CopyConfiguration,
  type FieldSchema,
  type SourceMessage,
  Stream,
  type SyncMode,
  diffSnapshot,
  validateRecords,
} from '@workspace/elt';

import type { MailScan } from './mail-scan.ts';
import type { MailSelection } from './mail-selection.ts';

// One record a stream reads, with the file it carries, if any. A staged file
// lives only until the stream reads its next entry.
export type MailEntry = {
  readonly data: Record<string, unknown>;
  readonly file: string | null;
};

// Turns a stream's entries into its validated records, the ones the import
// scope keeps, noting each one's file.
export type MailRecords = (
  entries: AsyncIterable<MailEntry> | Iterable<MailEntry>,
) => AsyncGenerator<Record<string, unknown>>;

export type MailSchema = {
  readonly type: 'object';
  readonly description: string;
  readonly properties: Readonly<Record<string, FieldSchema>>;
  readonly required: readonly string[];
};

export const mailSchema = (
  description: string,
  properties: Readonly<Record<string, FieldSchema>>,
): MailSchema => ({
  type: 'object',
  description,
  properties,
  required: Object.keys(properties),
});

// A Mail stream: its description, and how its records come out of a run's
// scan. Reading is the same for every stream: read one entry, keep it only if
// the import scope does, validate it and note its file, then read the next,
// so a file staged for one record is never held past it. Streams supply the
// entries and what the scope keeps.
export abstract class AppleMailStream {
  abstract readonly name: string;
  abstract readonly jsonSchema: MailSchema;
  abstract readonly primaryKey: readonly string[];
  readonly supportedSyncModes: readonly SyncMode[] = Object.freeze([
    'full_refresh',
    'incremental',
  ]);
  // Every read is the whole store, so incremental copies diff snapshots.
  readonly sourceDefinedCursor = true;
  readonly emitsDeletes = true;
  #stream?: Stream;

  describe(): Stream {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }

  async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    scan: MailScan,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const { selection } = scan;
    const accepts = (data: Record<string, unknown>) =>
      selection === null || this.accepts(data, selection);
    let file: string | null = null;
    const records: MailRecords = async function* (entries) {
      for await (const entry of entries) {
        if (!accepts(entry.data)) continue;
        file = entry.file;
        yield* validateRecords(stream, [entry.data], 'Mail');
      }
    };
    const entries = () => this.entries(scan);
    const messages =
      configuration.syncMode !== 'incremental'
        ? (async function* () {
            for await (const data of records(entries()))
              yield { stream: stream.name, data };
          })()
        : this.snapshot(stream, scan, records, state);
    for await (const message of messages)
      yield 'type' in message || configuration.fileReads.length === 0
        ? message
        : { ...message, file };
  }

  // An incremental read: the scan compared with the saved snapshot.
  protected snapshot(
    stream: Stream,
    scan: MailScan,
    records: MailRecords,
    state: unknown,
  ): AsyncIterable<SourceMessage> {
    return diffSnapshot(stream, records(this.entries(scan)), state);
  }

  protected abstract entries(
    scan: MailScan,
  ): AsyncIterable<MailEntry> | Iterable<MailEntry>;

  // Whether an import scope keeps the record.
  protected abstract accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean;
}
