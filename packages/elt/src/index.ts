export { Catalog } from './core/catalog.ts';
export { Connection } from './core/connection.ts';
export { Copy, type CopyOutcome, type CopyResult } from './core/copy.ts';
export {
  CopyConfiguration,
  type DedupPolicy,
} from './core/copy-configuration.ts';
export type { Deduplication } from './core/deduplication.ts';
export {
  Destination,
  type DestinationSyncMode,
  type Load,
} from './core/destination.ts';
export { DocumentParser } from './core/document-parser.ts';
export { FileContent } from './core/file-content.ts';
export { FileRead, FileReference } from './core/file-read.ts';
export { FileStorage } from './core/file-storage.ts';
export { isCalendarDate, isTimestamp } from './core/formats.ts';
export type { Partition, PartitionState } from './core/partition.ts';
export { type Pass, Pipeline, PipelineError } from './core/pipeline.ts';
export {
  type FieldSchema,
  type SchemaRecord,
  validateRecords,
} from './core/record-validation.ts';
export {
  diffGroupedSnapshot,
  diffSnapshot,
  type GroupedSnapshotState,
  type SnapshotGroup,
  type SnapshotState,
} from './core/snapshot.ts';
export {
  type DeleteMessage,
  type ExtractionCoverage,
  type JsonValue,
  type KeyValue,
  type ReadMessage,
  type RecordMessage,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  type StateMessage,
  StreamStatus,
} from './core/source.ts';
export { Stream, type SyncMode } from './core/stream.ts';
export { Target } from './core/target.ts';
export {
  type FieldValues,
  type LoadFailure,
  type Stage,
  TargetMissingError,
  TargetOwnedError,
  type WriteCount,
  type WriteOperation,
  Writer,
} from './core/writer.ts';
export {
  type CheckpointRun,
  type CheckpointSession,
  CheckpointStore,
  type StoredCheckpoint,
} from './state/checkpoint-store.ts';
export {
  copyStatus,
  type DeclaredCopy,
  passError,
  passStatus,
  type RecordedPass,
  SyncHistory,
  type SyncStatus,
} from './state/sync-history.ts';
export { LocalFiles } from './storage/local-files.ts';
