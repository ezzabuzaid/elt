import type {
  AppDatabaseVersion,
  AppFilesVersion,
} from '@workspace/sdk-macos-app-database';

// What changes when one Books store does. Books and bookdatastored commit
// through WALs they keep open, so a database reports each commit through
// data_version; preference files are rewritten whole, so a changed file stamp
// of either marks a new one.
export type BooksVersion = AppDatabaseVersion | AppFilesVersion;
