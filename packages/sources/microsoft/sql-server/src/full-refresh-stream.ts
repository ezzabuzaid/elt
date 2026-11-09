import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
} from '@eltjs/elt';
import type {
  SqlServerSession,
  SqlServerTable,
} from '@eltjs/sdk-microsoft-sql-server';

import { SqlServerStream } from './sql-server-stream.ts';
import type { WatchGauges } from './watch-gauges.ts';
import type { WholeTableGauges } from './whole-table-gauges.ts';

// A table with no key the login can read in full, so no change can apply by
// key: every read takes every row, and a copy replaces what it loaded before.
export class FullRefreshStream extends SqlServerStream {
  readonly #whole: WholeTableGauges;

  constructor(table: SqlServerTable, whole: WholeTableGauges) {
    super(table, {
      supportedSyncModes: ['full_refresh'],
      strategy: `Read in full on every sync.${whole.hint}`,
    });
    this.#whole = whole;
  }

  gauges(watch: WatchGauges) {
    return this.#whole.gauges(this.table, watch);
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
