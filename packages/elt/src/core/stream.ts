import { Deduplication } from './deduplication.ts';
import { FileReference } from './file-read.ts';

export type SyncMode = 'full_refresh' | 'incremental';

// A source's immutable description of a resource, without extraction behavior.
export class Stream {
  readonly name: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly primaryKey: readonly string[];
  readonly supportedSyncModes: readonly SyncMode[];
  readonly supportsFileTransfer?: true;
  // Incremental progress is opaque source state, so copies select no cursorField.
  readonly sourceDefinedCursor?: true;
  // Incremental reads may emit DELETE messages keyed by primaryKey.
  readonly emitsDeletes?: true;
  // The source reads the stream once per value of these primaryKey fields and
  // keeps each partition's state apart; every record carries its partition.
  readonly partitionKey?: readonly string[];

  constructor({
    name,
    jsonSchema,
    primaryKey = [],
    supportedSyncModes,
    supportsFileTransfer,
    sourceDefinedCursor,
    emitsDeletes,
    partitionKey,
  }: {
    name: string;
    jsonSchema: Readonly<Record<string, unknown>>;
    primaryKey?: readonly string[];
    supportedSyncModes: readonly SyncMode[];
    supportsFileTransfer?: true;
    sourceDefinedCursor?: true;
    emitsDeletes?: true;
    partitionKey?: readonly string[];
  }) {
    if (!name || name.includes('\0'))
      throw new TypeError('Invalid stream name');
    if (
      !Array.isArray(supportedSyncModes) ||
      supportedSyncModes.length === 0 ||
      !supportedSyncModes.every(
        (mode) => mode === 'full_refresh' || mode === 'incremental',
      ) ||
      new Set(supportedSyncModes).size !== supportedSyncModes.length
    )
      throw new TypeError('A stream requires distinct supported sync modes');
    this.name = name;
    if (supportsFileTransfer !== undefined && supportsFileTransfer !== true)
      throw new TypeError('supportsFileTransfer must be true when declared');
    this.supportsFileTransfer = supportsFileTransfer;
    if (sourceDefinedCursor !== undefined && sourceDefinedCursor !== true)
      throw new TypeError('sourceDefinedCursor must be true when declared');
    if (emitsDeletes !== undefined && emitsDeletes !== true)
      throw new TypeError('emitsDeletes must be true when declared');
    if (
      (sourceDefinedCursor || emitsDeletes) &&
      !supportedSyncModes.includes('incremental')
    )
      throw new TypeError(
        'A source-defined cursor or deletions require incremental support',
      );
    if (emitsDeletes && primaryKey.length === 0)
      throw new TypeError(
        'A stream that emits deletions requires a primaryKey',
      );
    this.sourceDefinedCursor = sourceDefinedCursor;
    this.emitsDeletes = emitsDeletes;
    this.jsonSchema = structuredClone(jsonSchema);
    // Snapshot nested metadata too, so changes in a source cannot rewrite a pipeline.
    const seen = new WeakSet<object>();
    const freeze = (value: unknown): void => {
      if (value === null || typeof value !== 'object' || seen.has(value))
        return;
      seen.add(value);
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    };
    freeze(this.jsonSchema);
    this.primaryKey = Object.freeze([...primaryKey]);
    this.supportedSyncModes = Object.freeze([...supportedSyncModes]);
    if (partitionKey !== undefined) {
      if (
        !Array.isArray(partitionKey) ||
        partitionKey.length === 0 ||
        new Set(partitionKey).size !== partitionKey.length ||
        !partitionKey.every((field) => primaryKey.includes(field))
      )
        throw new TypeError(
          'partitionKey fields must be distinct members of primaryKey',
        );
      this.partitionKey = Object.freeze([...partitionKey]);
      new Deduplication(this, this.partitionKey);
    }
    Object.freeze(this);
  }
  get file(): FileReference {
    if (this.supportsFileTransfer !== true)
      throw new TypeError(
        `Stream ${this.name} does not support file extraction`,
      );
    return new FileReference(this);
  }
}
