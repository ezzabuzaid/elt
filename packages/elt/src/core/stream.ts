import { FileReference } from './file-read.ts';

export type SyncMode = 'full_refresh' | 'incremental';

// A source's immutable description of a resource, without extraction behavior.
export class Stream {
  readonly name: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly primaryKey: readonly string[];
  readonly supportedSyncModes: readonly SyncMode[];
  readonly supportsFileTransfer?: true;

  constructor({
    name,
    jsonSchema,
    primaryKey = [],
    supportedSyncModes,
    supportsFileTransfer,
  }: {
    name: string;
    jsonSchema: Readonly<Record<string, unknown>>;
    primaryKey?: readonly string[];
    supportedSyncModes: readonly SyncMode[];
    supportsFileTransfer?: true;
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
