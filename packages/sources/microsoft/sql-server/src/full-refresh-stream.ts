import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
} from '@workspace/elt';
import type {
  SqlServerSession,
  SqlServerTable,
} from '@workspace/sdk-microsoft-sql-server';

import { SqlServerStream } from './sql-server-stream.ts';

// A table with no change signal the login can read: every read takes every
// row, and a copy replaces what it loaded before.
export class FullRefreshStream extends SqlServerStream {
  constructor(table: SqlServerTable) {
    const hint =
      table.changeTracking === 'denied' && table.primaryKey.length > 0
        ? ` Granting the login VIEW CHANGE TRACKING ON ${table.quoted} would read only changes and deletions.`
        : '';
    super(table, {
      supportedSyncModes: ['full_refresh'],
      strategy: `Read in full on every sync.${hint}`,
    });
  }

  coverage(): ExtractionCoverage {
    return {
      description: `Every row of ${this.table.quoted} the login can read`,
      selection: { table: this.table.quoted },
    };
  }

  extract(
    _configuration: CopyConfiguration,
    _state: unknown,
    session: SqlServerSession,
  ): AsyncIterable<SourceMessage> {
    return this.everyRow(session);
  }
}
