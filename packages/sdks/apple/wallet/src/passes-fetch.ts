import { type SnapshotColumns } from '@zukhruf/sqlite-snapshot';

import { referenceDate } from '@workspace/codec-apple-reference-date';

import { appDatabase } from './app-database.ts';

const requiredColumns = {
  cloud_store_zone: ['zone_name', 'fetch_timestamp'],
} satisfies SnapshotColumns;

// When passd last fetched the passes zone, the passes this Mac syncs through
// iCloud, or null when it never has. passd keeps one zone row per CloudKit
// database, so the passes are current only as of the oldest fetch among
// them; a database it has never fetched has no time and holds no passes
// here. Read and closed at once, as walletRecords is.
export function lastPassesFetch(path: string): Date | null {
  using database = appDatabase.snapshot(path, requiredColumns);
  const fetched = database
    .all(
      "SELECT fetch_timestamp FROM cloud_store_zone WHERE zone_name = 'passes' AND fetch_timestamp IS NOT NULL",
    )
    .map(({ fetch_timestamp }) => Number(fetch_timestamp));
  return fetched.length === 0 ? null : referenceDate(Math.min(...fetched));
}
