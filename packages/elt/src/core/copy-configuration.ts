import { Deduplication } from './deduplication.ts';
import type { DestinationSyncMode } from './destination.ts';
import { FileRead } from './file-read.ts';
import { Stream, type SyncMode } from './stream.ts';

// A copy's immutable selection, separate from discovery metadata and runtime state.
export class CopyConfiguration {
  readonly stream: Stream;
  readonly fileReads: readonly FileRead[];
  readonly syncMode: SyncMode;
  readonly destinationSyncMode: DestinationSyncMode;
  readonly cursorField?: string;
  readonly primaryKey?: readonly string[];

  constructor(
    from: Stream,
    {
      syncMode,
      destinationSyncMode,
      cursorField,
      primaryKey,
    }: {
      syncMode: SyncMode;
      destinationSyncMode: DestinationSyncMode;
      cursorField?: string;
      primaryKey?: readonly string[];
    },
    fileReads: readonly FileRead[] = [],
  ) {
    if (!(from instanceof Stream))
      throw new TypeError('Copy requires a stream description');
    if (
      !Array.isArray(fileReads) ||
      !fileReads.every((read) => read instanceof FileRead)
    )
      throw new TypeError('Copy requires FileRead declarations');
    if (
      new Set(fileReads.map((read) => read.name.toLowerCase())).size !==
      fileReads.length
    )
      throw new TypeError('Duplicate file field names');
    if (typeof syncMode !== 'string' || typeof destinationSyncMode !== 'string')
      throw new TypeError('Both syncMode and destinationSyncMode are required');
    if (primaryKey !== undefined && !Array.isArray(primaryKey))
      throw new TypeError('primaryKey must be an array of field names');
    this.stream = from;
    this.fileReads = Object.freeze([...fileReads]);
    this.syncMode = syncMode;
    this.destinationSyncMode = destinationSyncMode;
    this.cursorField = cursorField;
    this.primaryKey =
      primaryKey === undefined ? undefined : Object.freeze([...primaryKey]);
    Object.freeze(this);
  }

  validate(stream: Stream): void {
    if (
      !this.stream.supportedSyncModes.includes(this.syncMode) ||
      !stream.supportedSyncModes.includes(this.syncMode)
    )
      throw new TypeError(
        `Stream ${stream.name} does not support ${this.syncMode}`,
      );
    this.validateSelection();
    for (const read of this.fileReads) read.validate(stream);
  }
  validateSelection(): void {
    for (const read of this.fileReads) read.validate(this.stream);
    const { syncMode, destinationSyncMode, cursorField, primaryKey } = this;
    if (syncMode !== 'full_refresh' && syncMode !== 'incremental')
      throw new TypeError(`Unsupported syncMode: ${syncMode}`);
    if (
      syncMode === 'incremental' &&
      (destinationSyncMode === 'overwrite' ||
        destinationSyncMode === 'overwrite_dedup')
    )
      throw new TypeError(
        'Incremental extraction cannot use overwrite loading',
      );
    if (syncMode === 'full_refresh' && destinationSyncMode === 'append_dedup')
      throw new TypeError(
        'Full refresh deduplication requires overwrite_dedup',
      );
    if (
      syncMode === 'incremental' &&
      (typeof cursorField !== 'string' || !cursorField)
    )
      throw new TypeError('Incremental extraction requires cursorField');
    if (
      destinationSyncMode === 'append_dedup' ||
      destinationSyncMode === 'overwrite_dedup'
    ) {
      if (primaryKey === undefined || cursorField === undefined)
        throw new TypeError(
          'Deduplication requires explicit primaryKey and cursorField',
        );
      new Deduplication(this.stream, primaryKey, cursorField);
    } else if (primaryKey !== undefined) {
      throw new TypeError('Select primaryKey only for deduplication loading');
    }
    if (
      syncMode === 'full_refresh' &&
      destinationSyncMode !== 'overwrite_dedup' &&
      cursorField !== undefined
    )
      throw new TypeError(
        'Full refresh append/overwrite does not use cursorField',
      );
  }

  deduplication(): Deduplication {
    if (this.primaryKey === undefined || this.cursorField === undefined)
      throw new TypeError('Deduplication requires primaryKey and cursorField');
    return new Deduplication(this.stream, this.primaryKey, this.cursorField);
  }
}
