import type { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import {
  type CopyOutcome,
  type CopyProgress,
  type FailureType,
  type ObservedPass,
  type PassObserver,
  type SyncStatus,
  passError,
  passFailureType,
  passStatus,
} from '@workspace/elt';
import type { SQLiteTable } from '@workspace/elt-sqlite';

// How one pass of one connector ended, as sync reports it.
export type PassSummary = {
  readonly connector: string;
  readonly status: SyncStatus;
  readonly seconds: number;
  readonly streams: readonly {
    readonly stream: string;
    readonly written: number;
    readonly deleted: number;
    readonly errors: readonly string[];
  }[];
  readonly error: string | null;
};

// One line a sync shows for an import: how its pass ended; removed, another
// setup removed its connector while it ran; interrupted, the sync whose pass
// this one waited for stopped first; or watched, a sync watch keeps it
// current, so this sync runs no pass of it.
export type SyncLine =
  | PassSummary
  | { readonly connector: string; readonly status: 'removed' }
  | { readonly connector: string; readonly status: 'interrupted' }
  | { readonly connector: string; readonly status: 'watched' };

// What a sync shows of each pass while it runs and once it ends.
export type PassReport = {
  progress(
    connector: AppleConnector,
    progress: CopyProgress<SQLiteTable>,
  ): void;
  passed(connector: AppleConnector, summary: PassSummary): void;
};

// Shows the report each pass of one connector: each copy's progress while it
// runs, and how the pass ended once the import's sync history recorded it.
export class ObservedPasses implements PassObserver<SQLiteTable> {
  readonly #connector: AppleConnector;
  readonly #report: PassReport;

  constructor(connector: AppleConnector, report: PassReport) {
    this.#connector = connector;
    this.#report = report;
  }

  begin(): ObservedPass<SQLiteTable> {
    const connector = this.#connector;
    const started = performance.now();
    const seconds = () => Math.round((performance.now() - started) / 1000);
    return {
      progress: (progress) => this.#report.progress(connector, progress),
      finish: (outcomes) =>
        this.#report.passed(
          connector,
          summarize(connector, outcomes, seconds()),
        ),
      fail: (error, failureType) =>
        this.#report.passed(
          connector,
          failed(connector, error, seconds(), failureType),
        ),
    };
  }
}

function summarize(
  connector: AppleConnector,
  outcomes: readonly CopyOutcome<SQLiteTable>[],
  seconds: number,
): PassSummary {
  const error = passError(outcomes);
  return {
    connector: connector.name,
    status: passStatus(outcomes),
    seconds,
    streams: outcomes.map(({ copy, count, deleted, failures }) => ({
      stream: copy.from.name,
      written: count,
      deleted,
      errors: failures.map(({ error }) => message(error)),
    })),
    error:
      error === null
        ? null
        : connector.failure(error, passFailureType(outcomes)),
  };
}

export function failed(
  connector: AppleConnector,
  error: unknown,
  seconds: number,
  failureType: FailureType = connector.failureType(error),
): PassSummary {
  return {
    connector: connector.name,
    status: 'failed',
    seconds,
    streams: [],
    error: connector.failure(error, failureType),
  };
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
