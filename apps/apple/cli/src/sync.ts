import type { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import {
  type Connection,
  type CopyOutcome,
  type CopyProgress,
  type DeclaredCopy,
  type FailureType,
  type RecordedPass,
  type SyncStatus,
  passError,
  passFailureType,
  passStatus,
} from '@workspace/elt';
import { SQLiteSyncHistory, type SQLiteTable } from '@workspace/elt-sqlite';

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

// Sees each pass of a sync while it runs and once it ends.
export type PassObserver = {
  progress(
    connector: AppleConnector,
    progress: CopyProgress<SQLiteTable>,
  ): void;
  passed(connector: AppleConnector, summary: PassSummary): void;
};

// Records every pass in each connector's data.sqlite, as any SQLite load
// does, and shows the observer each pass while it runs and once it ends.
export class ObservedHistory extends SQLiteSyncHistory {
  readonly #connectors: readonly AppleConnector[];
  readonly #observer: PassObserver;

  constructor(connectors: readonly AppleConnector[], observer: PassObserver) {
    super();
    this.#connectors = connectors;
    this.#observer = observer;
  }

  override async begin(
    connection: Connection<SQLiteTable>,
    copies: readonly DeclaredCopy<SQLiteTable>[],
  ): Promise<RecordedPass<SQLiteTable>> {
    const connector = this.#connectors.find(
      ({ name }) => name === connection.name,
    );
    if (connector === undefined)
      throw new TypeError(`No connector for connection ${connection.name}`);
    const started = performance.now();
    const seconds = () => Math.round((performance.now() - started) / 1000);
    const pass = await super.begin(connection, copies);
    return {
      progress: (progress) => this.#observer.progress(connector, progress),
      finish: async (outcomes) => {
        await pass.finish(outcomes);
        this.#observer.passed(
          connector,
          summarize(connector, outcomes, seconds()),
        );
      },
      fail: async (error, failureType) => {
        await pass.fail(error, failureType);
        this.#observer.passed(
          connector,
          failed(connector, error, seconds(), failureType),
        );
      },
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
