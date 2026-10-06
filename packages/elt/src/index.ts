export { Catalog } from './core/catalog.ts';
export { Connection } from './core/connection.ts';
export {
  Copy,
  type CopyOutcome,
  type CopyProgress,
  type CopyResult,
} from './core/copy.ts';
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
export { isCalendarDate } from './core/formats/calendar-date-format.ts';
export {
  type DeclaredFormat,
  declaredFormat,
} from './core/formats/declared-format.ts';
export { isTimestamp } from './core/formats/timestamp-format.ts';
export type { Partition, PartitionState } from './core/partition.ts';
export { type Pass, Pipeline, PipelineError } from './core/pipeline.ts';
export { type ReaderRelation, readerCatalog } from './core/reader-relation.ts';
export {
  type FieldSchema,
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  type StreamSchema,
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
  type ResetMessage,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  type StateMessage,
  StreamStatus,
} from './core/source.ts';
export { Stream, type SyncMode } from './core/stream.ts';
export { Target } from './core/target.ts';
export {
  type DescribedColumn,
  describeTarget,
  type TargetDescription,
  undescribed,
} from './core/target-description.ts';
export {
  type FieldValues,
  type LoadFailure,
  type Stage,
  TargetOwnedError,
  type WriteCount,
  type WriteOperation,
  Writer,
} from './core/writer.ts';
export {
  type CheckpointBinding,
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
export { syncHistoryRelations } from './state/sync-history-relations.ts';
export { LocalFiles } from './storage/local-files.ts';
