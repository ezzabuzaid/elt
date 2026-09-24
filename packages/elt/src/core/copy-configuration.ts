import { Deduplication } from './deduplication.ts';
import type { DestinationSyncMode } from './destination.ts';
import { FileRead } from './file-read.ts';
import { Stream, type SyncMode } from './stream.ts';

// How a deduplicating load resolves a conflict on the primary key.
// cursor_newer keeps the row whose cursor sorts highest, which protects against
// out-of-order replay. replace lets the newest extraction win, which is what a
// source that restates already-loaded facts requires.
export type DedupPolicy = 'cursor_newer' | 'replace';

// A copy's immutable selection, separate from discovery metadata and runtime state.
export class CopyConfiguration {
  readonly stream: Stream;
  readonly fileReads: readonly FileRead[];
  readonly syncMode: SyncMode;
  readonly destinationSyncMode: DestinationSyncMode;
  readonly cursorField?: string;
  readonly primaryKey?: readonly string[];
  // Set only for deduplicating loads; cursor_newer unless the copy selects replace.
  readonly dedupPolicy?: DedupPolicy;

  constructor(
    from: Stream,
    {
      syncMode,
      destinationSyncMode,
      cursorField,
      primaryKey,
      dedupPolicy,
    }: {
      syncMode: SyncMode;
      destinationSyncMode: DestinationSyncMode;
      cursorField?: string;
      primaryKey?: readonly string[];
      dedupPolicy?: DedupPolicy;
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
    // A source-defined cursor leaves no field to compare, so the newest extraction wins.
    this.dedupPolicy =
      destinationSyncMode === 'append_dedup' ||
      destinationSyncMode === 'overwrite_dedup'
        ? (dedupPolicy ??
          (from.sourceDefinedCursor ? 'replace' : 'cursor_newer'))
        : dedupPolicy;
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
    const {
      syncMode,
      destinationSyncMode,
      cursorField,
      primaryKey,
      dedupPolicy,
    } = this;
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
    const { sourceDefinedCursor, emitsDeletes } = this.stream;
    if (sourceDefinedCursor && cursorField !== undefined)
      throw new TypeError(
        `Stream ${this.stream.name} defines its own cursor; omit cursorField`,
      );
    if (
      syncMode === 'incremental' &&
      !sourceDefinedCursor &&
      (typeof cursorField !== 'string' || !cursorField)
    )
      throw new TypeError('Incremental extraction requires cursorField');
    if (emitsDeletes && syncMode === 'incremental') {
      if (destinationSyncMode !== 'append_dedup')
        throw new TypeError(
          `Stream ${this.stream.name} emits deletions; incremental copies require append_dedup`,
        );
      if (
        primaryKey === undefined ||
        primaryKey.length !== this.stream.primaryKey.length ||
        primaryKey.some(
          (field, index) => field !== this.stream.primaryKey[index],
        )
      )
        throw new TypeError(
          `Stream ${this.stream.name} emits deletions by its primary key; select primaryKey ${JSON.stringify(this.stream.primaryKey)}`,
        );
    }
    if (
      dedupPolicy !== undefined &&
      dedupPolicy !== 'cursor_newer' &&
      dedupPolicy !== 'replace'
    )
      throw new TypeError(`Unsupported dedupPolicy: ${dedupPolicy}`);
    if (
      destinationSyncMode === 'append_dedup' ||
      destinationSyncMode === 'overwrite_dedup'
    ) {
      if (primaryKey === undefined)
        throw new TypeError('Deduplication requires an explicit primaryKey');
      if (dedupPolicy === 'cursor_newer' && cursorField === undefined)
        throw new TypeError(
          sourceDefinedCursor
            ? `Stream ${this.stream.name} has no cursor field to compare; deduplicate with dedupPolicy 'replace'`
            : 'cursor_newer deduplication requires cursorField',
        );
      new Deduplication(this.stream, primaryKey, cursorField);
      // A cursor inside the primary key is equal on every conflict, so the
      // cursor_newer guard can never fire and restated facts load as no-ops.
      if (
        dedupPolicy === 'cursor_newer' &&
        cursorField !== undefined &&
        primaryKey.includes(cursorField)
      )
        throw new TypeError(
          `Cursor field ${cursorField} is part of the primary key, so cursor_newer can never update a conflicting row; select dedupPolicy 'replace' to let the newest extraction win`,
        );
    } else {
      if (primaryKey !== undefined)
        throw new TypeError('Select primaryKey only for deduplication loading');
      if (dedupPolicy !== undefined)
        throw new TypeError(
          'Select dedupPolicy only for deduplication loading',
        );
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
    if (this.primaryKey === undefined)
      throw new TypeError('Deduplication requires a primaryKey');
    return new Deduplication(this.stream, this.primaryKey, this.cursorField);
  }
}
