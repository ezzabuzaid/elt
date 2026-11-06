import type {
  SqlServerSession,
  SqlServerTable,
} from '@workspace/sdk-microsoft-sql-server';

// What a signal reads on one check of a watch: the watch's session, and the
// times on the watch's clock when the watch started and when the read began.
export type Check = {
  readonly session: SqlServerSession;
  readonly started: number;
  readonly now: number;
};

// What a watch reads on each check to tell whether a table changed: one read
// for every table, which gives each table a value. A stream names the
// signals that can see the changes its read finds, and a check wakes the
// stream when the value of any of them is not the value of the last check.
export abstract class ChangeSignal {
  abstract read(check: Check): Promise<(table: SqlServerTable) => unknown>;
}
