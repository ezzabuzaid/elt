import type { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import {
  type Connection,
  type CopyOutcome,
  type CopyProgress,
  type DeclaredCopy,
  Pipeline,
  type RecordedPass,
  type SyncStatus,
  passError,
  passStatus,
} from '@workspace/elt';
import {
  type SQLiteDestination,
  SQLiteSyncHistory,
  type SQLiteTable,
  installSQLiteCatalog,
} from '@workspace/elt-sqlite';
import type { ImportStore, Selection } from '@workspace/import-store';

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

// Records every pass in each connector's data.sqlite, as any SQLite load does, and
// shows the observer each pass while it runs and once it ends.
class ObservedHistory extends SQLiteSyncHistory {
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
      fail: async (error) => {
        await pass.fail(error);
        this.#observer.passed(connector, failed(connector, error, seconds()));
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
    error: error === null ? null : connector.failure(error),
  };
}

function failed(
  connector: AppleConnector,
  error: unknown,
  seconds: number,
): PassSummary {
  return {
    connector: connector.name,
    status: 'failed',
    seconds,
    streams: [],
    error: connector.failure(error),
  };
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// One pass of each connector's selected import. The caller holds the store's lease
// throughout.
export async function syncImports(
  store: ImportStore,
  imports: readonly { connector: AppleConnector; selection: Selection }[],
  observer: PassObserver,
): Promise<void> {
  const connections: Connection<SQLiteTable>[] = [];
  const destinations: SQLiteDestination[] = [];
  for (const { connector, selection } of imports) {
    try {
      const { connection, destination } = await connector.connection(
        store.directory(selection),
        selection,
      );
      store.clearConnectionFailure(selection);
      connections.push(connection);
      destinations.push(destination);
    } catch (error) {
      // No pipeline exists to record it, so the store keeps it for status.
      store.saveConnectionFailure(selection, message(error));
      observer.passed(connector, failed(connector, error, 0));
    }
  }
  if (connections.length === 0) return;
  const history = new ObservedHistory(
    imports.map(({ connector }) => connector),
    observer,
  );
  await history.install(destinations);
  for (const { path } of destinations) installSQLiteCatalog({ path });
  const pipeline = new Pipeline({ connections, history });
  // Failures reach the observer through the history; the rest is a wiring
  // mistake and propagates.
  await pipeline.run().catch(rethrowUnrecorded);
}

function rethrowUnrecorded(error: unknown): void {
  if (error instanceof AggregateError) return;
  throw error;
}
