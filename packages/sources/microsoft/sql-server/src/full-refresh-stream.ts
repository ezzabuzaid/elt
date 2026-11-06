import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
} from '@workspace/elt';
import type {
  SqlServerSession,
  SqlServerTable,
} from '@workspace/sdk-microsoft-sql-server';

import type { WholeTableSignals } from './signals/whole-table-signals.ts';
import { SqlServerStream } from './sql-server-stream.ts';

// A table with no key the login can read in full, so no change can apply by
// key: every read takes every row, and a copy replaces what it loaded before.
export class FullRefreshStream extends SqlServerStream {
  constructor(table: SqlServerTable, watch: WholeTableSignals) {
    super(table, {
      supportedSyncModes: ['full_refresh'],
      strategy: `Read in full on every sync.${watch.hint}`,
      signals: watch.signals,
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
