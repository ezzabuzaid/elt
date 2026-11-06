import type { Gauge } from '@zukhruf/async';

import {
  SqlServerPermissionError,
  type SqlServerSession,
  type SqlServerTable,
} from '@workspace/sdk-microsoft-sql-server';

import type { WatchGauges } from './watch-gauges.ts';

type TableCollector = 'statistics' | 'rowCounts' | 'lastWrites';

// The gauges of a stream that reads its whole table: its statistics, its
// row count, when the login may read them its last write, and the hour.
// Without the last write, an update of a column with no statistics waits for
// the hour, and hint says which grant would wake the stream at once.
export class WholeTableGauges {
  readonly hint: string;
  readonly #collectors: readonly TableCollector[];

  private constructor(collectors: readonly TableCollector[], hint: string) {
    this.#collectors = collectors;
    this.hint = hint;
  }

  // Tries to read the last writes once, as a watch would.
  static async discover(session: SqlServerSession): Promise<WholeTableGauges> {
    try {
      await session.lastWrites();
      return new WholeTableGauges(
        ['statistics', 'rowCounts', 'lastWrites'],
        '',
      );
    } catch (error) {
      if (!(error instanceof SqlServerPermissionError)) throw error;
      return new WholeTableGauges(
        ['statistics', 'rowCounts'],
        ` Granting the login ${error.grant} would wake a watch on any write, also to a column with no statistics.`,
      );
    }
  }

  gauges(table: SqlServerTable, watch: WatchGauges): readonly Gauge[] {
    return [
      ...this.#collectors.map((name) => watch[name].gauge(table.quoted)),
      watch.hour,
    ];
  }
}
