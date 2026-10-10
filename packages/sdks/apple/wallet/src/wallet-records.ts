import {
  AppDatabase,
  type AppDatabaseColumns,
  referenceDateInstant,
} from '@workspace/sdk-apple-app-database';

import { WalletSchemaError, WalletUnavailableError } from './errors.ts';
import type { WalletRecord } from './pass.ts';

const requiredColumns = {
  pass: ['pid', 'unique_id', 'ingested_date', 'modified_date', 'signing_date'],
  pass_annotations: ['pass_pid', 'sorting_state', 'archived_timestamp'],
} satisfies AppDatabaseColumns;

// What Wallet records about each pass, read from one moment of passd's
// database and closed at once: passd commits through a rollback journal, so
// a reader holding the database blocks its writes.
export function walletRecords(path: string): WalletRecord[] {
  using database = new AppDatabase(path, WalletUnavailableError);
  database.requireColumns(requiredColumns, WalletSchemaError);
  return database
    .all(
      `SELECT pass.unique_id AS id,
              pass.ingested_date AS addedAt,
              pass.modified_date AS updatedAt,
              pass.signing_date AS signedAt,
              pass_annotations.archived_timestamp AS archivedAt,
              pass_annotations.sorting_state AS sortingState
       FROM pass
       LEFT JOIN pass_annotations ON pass_annotations.pass_pid = pass.pid
       ORDER BY pass.ingested_date, pass.unique_id`,
    )
    .map((row) => {
      if (typeof row.id !== 'string')
        throw new TypeError('A Wallet pass has no unique ID');
      return {
        id: row.id,
        addedAt: instant(row.addedAt),
        updatedAt: instant(row.updatedAt),
        signedAt: instant(row.signedAt),
        archivedAt: instant(row.archivedAt),
        sortingState:
          row.sortingState === null ? null : Number(row.sortingState),
      };
    });
}

function instant(value: unknown): string | null {
  return value === null ? null : referenceDateInstant(Number(value));
}
