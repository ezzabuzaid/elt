import {
  SqlServerPermissionError,
  type SqlServerSession,
} from '@workspace/sdk-microsoft-sql-server';

import type { ChangeSignal } from './change-signal.ts';
import { hourly } from './hourly.ts';
import { lastWrite } from './last-write.ts';
import { statisticsChanges } from './statistics-changes.ts';

// The signals of a stream that reads its whole table: its statistics, when
// the login may read them its last write, and the hour. Without the last
// write, an update of a column with no statistics waits for the hour, and
// hint says which grant would wake the stream at once.
export class WholeTableSignals {
  readonly signals: readonly ChangeSignal[];
  readonly hint: string;

  private constructor(signals: readonly ChangeSignal[], hint: string) {
    this.signals = signals;
    this.hint = hint;
  }

  // Tries to read the last writes once, as a watch would.
  static async discover(session: SqlServerSession): Promise<WholeTableSignals> {
    try {
      await session.lastWrites();
      return new WholeTableSignals([statisticsChanges, lastWrite, hourly], '');
    } catch (error) {
      if (!(error instanceof SqlServerPermissionError)) throw error;
      return new WholeTableSignals(
        [statisticsChanges, hourly],
        ` Granting the login ${error.grant} would wake a watch on any write, also to a column with no statistics.`,
      );
    }
  }
}
