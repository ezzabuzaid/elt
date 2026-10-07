import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
} from '@workspace/elt';
import type {
  SqlServerSession,
  SqlServerTable,
} from '@workspace/sdk-microsoft-sql-server';

import { SqlServerStream, pageSize } from './sql-server-stream.ts';

function parse(state: unknown): string {
  if (state === null) return '0';
  if (
    typeof state === 'object' &&
    'above' in state &&
    typeof state.above === 'string'
  )
    return state.above;
  throw new TypeError(`Unknown rowversion state ${JSON.stringify(state)}`);
}

// A keyed table with a rowversion column and no Change Tracking the login
// can read: each read takes the rows inserted or updated since the last,
// in rowversion order, up to the oldest write still open. A deleted row is
// never seen, so it stays loaded.
export class RowversionStream extends SqlServerStream {
  constructor(table: SqlServerTable) {
    super(table, {
      supportedSyncModes: ['full_refresh', 'incremental'],
      sourceDefinedCursor: true,
      strategy: `Read by its rowversion column ${table.rowversion?.name}: inserts and updates apply; deletions are not seen.`,
    });
  }

  coverage(): ExtractionCoverage {
    return {
      description: `Every row of ${this.table.quoted} the login can read, inserted or updated since the last read`,
      selection: { table: this.table.quoted },
    };
  }

  async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    session: SqlServerSession,
  ): AsyncGenerator<SourceMessage> {
    if (configuration.syncMode === 'full_refresh') {
      yield* this.everyRow(session);
      return;
    }
    const column = this.#column();
    const below = await session.minActiveRowversion();
    let above = parse(state);
    for (;;) {
      let count = 0;
      for await (const row of session.rowversions(
        this.table,
        above,
        below,
        pageSize,
      )) {
        yield this.message(row);
        above = String(row.value(column));
        count += 1;
      }
      if (count === 0) return;
      yield { type: 'STATE', stream: this.stream.name, state: { above } };
      if (count < pageSize) return;
    }
  }

  #column() {
    const column = this.table.rowversion;
    if (column === undefined)
      throw new TypeError(`${this.table.quoted} has no rowversion column`);
    return column;
  }
}
