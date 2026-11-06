import { ClosedWorld } from '@zukhruf/snapshot-differential';

import {
  type CopyConfiguration,
  type ExtractionCoverage,
  type SourceMessage,
  diffSnapshot,
} from '@workspace/elt';
import type {
  SqlServerSession,
  SqlServerTable,
} from '@workspace/sdk-microsoft-sql-server';

import { SqlServerStream } from './sql-server-stream.ts';
import type { WatchGauges } from './watch-gauges.ts';
import type { WholeTableGauges } from './whole-table-gauges.ts';

// A keyed table with no Change Tracking or rowversion the login can read:
// every read takes every row, and an incremental copy compares the read with
// the snapshot in its checkpoint, so it writes only the rows that are new or
// changed and deletes the rows that are gone. The read lists every row, so a
// key it does not list was deleted.
export class SnapshotStream extends SqlServerStream {
  readonly #whole: WholeTableGauges;

  constructor(table: SqlServerTable, whole: WholeTableGauges) {
    const hint =
      table.changeTracking === 'denied'
        ? ` Granting the login VIEW CHANGE TRACKING ON ${table.quoted} would read only changes and deletions.`
        : '';
    super(table, {
      supportedSyncModes: ['full_refresh', 'incremental'],
      sourceDefinedCursor: true,
      emitsDeletes: true,
      strategy: `Read in full on every sync; new and changed rows and deletions apply.${hint}${whole.hint}`,
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
    configuration: CopyConfiguration,
    state: unknown,
    session: SqlServerSession,
    signal: AbortSignal | undefined,
  ): AsyncIterable<SourceMessage> {
    return diffSnapshot(configuration, this.records(session), state, {
      policy: new ClosedWorld(),
      signal,
    });
  }
}
