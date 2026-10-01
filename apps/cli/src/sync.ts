import {
  type Connection,
  type CopyOutcome,
  type CopyProgress,
  type DeclaredCopy,
  Pipeline,
  passError,
  passStatus,
  type RecordedPass,
  type SyncStatus,
} from 'elt';
import {
  installSQLiteCatalog,
  type SQLiteDestination,
  SQLiteSyncHistory,
  type SQLiteTable,
} from 'elt-sqlite';
import type { AppleApp } from './apps/apple-app.ts';
import type { Store } from './store.ts';

// How one pass of one app ended, as sync reports it.
export type PassSummary = {
  readonly app: string;
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

export type SyncObserver = {
  progress(app: AppleApp, progress: CopyProgress<SQLiteTable>): void;
  passed(app: AppleApp, summary: PassSummary): void;
};

// Records every pass in each app's data.sqlite, as any SQLite load does, and
// shows the observer each pass while it runs and once it ends.
class ObservedHistory extends SQLiteSyncHistory {
  readonly #apps: readonly AppleApp[];
  readonly #observer: SyncObserver;

  constructor(apps: readonly AppleApp[], observer: SyncObserver) {
    super();
    this.#apps = apps;
    this.#observer = observer;
  }

  override async begin(
    connection: Connection<SQLiteTable>,
    copies: readonly DeclaredCopy<SQLiteTable>[],
  ): Promise<RecordedPass<SQLiteTable>> {
    const app = this.#apps.find(({ name }) => name === connection.name);
    if (app === undefined)
      throw new TypeError(`No app for connection ${connection.name}`);
    const started = performance.now();
    const seconds = () => Math.round((performance.now() - started) / 1000);
    const pass = await super.begin(connection, copies);
    return {
      progress: (progress) => this.#observer.progress(app, progress),
      finish: async (outcomes) => {
        await pass.finish(outcomes);
        this.#observer.passed(app, summarize(app, outcomes, seconds()));
      },
      fail: async (error) => {
        await pass.fail(error);
        this.#observer.passed(app, failed(app, error, seconds()));
      },
    };
  }
}

function summarize(
  app: AppleApp,
  outcomes: readonly CopyOutcome<SQLiteTable>[],
  seconds: number,
): PassSummary {
  const error = passError(outcomes);
  return {
    app: app.name,
    status: passStatus(outcomes),
    seconds,
    streams: outcomes.map(({ copy, count, deleted, failures }) => ({
      stream: copy.from.name,
      written: count,
      deleted,
      errors: failures.map(({ error }) => message(error)),
    })),
    error: error === null ? null : app.failure(error),
  };
}

function failed(app: AppleApp, error: unknown, seconds: number): PassSummary {
  return {
    app: app.name,
    status: 'failed',
    seconds,
    streams: [],
    error: app.failure(error),
  };
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// One pass of each app, or with watch, a first pass and then one for each
// change its source reports, until the process stops. Holds the store's lock
// throughout, so a second sync is refused rather than colliding, and reads
// each app's selection under it.
export async function sync(
  store: Store,
  apps: readonly AppleApp[],
  watch: boolean,
  observer: SyncObserver,
): Promise<void> {
  using _ = store.lock();
  const selections = store.selections();
  const connections: Connection<SQLiteTable>[] = [];
  const destinations: SQLiteDestination[] = [];
  for (const app of apps)
    try {
      const selection = selections.find(({ app: name }) => name === app.name);
      if (selection === undefined)
        throw new Error(`${app.title} is not set up; run: setup`);
      const { connection, destination } = await app.connection(
        store,
        selection,
      );
      connections.push(connection);
      destinations.push(destination);
    } catch (error) {
      observer.passed(app, failed(app, error, 0));
    }
  if (connections.length === 0) return;
  const history = new ObservedHistory(apps, observer);
  await history.install(destinations);
  for (const { path } of destinations) installSQLiteCatalog({ path });
  const pipeline = new Pipeline({ connections, history });
  // Failures reach the observer through the history; the rest is a wiring
  // mistake and propagates.
  if (!watch) {
    await pipeline.run().catch(rethrowUnrecorded);
    return;
  }
  try {
    // Never aborted: a watch ends with the process, or once every app's
    // watcher stopped.
    for await (const _pass of pipeline.watch({
      signal: new AbortController().signal,
    }));
  } catch (error) {
    rethrowUnrecorded(error);
  }
}

function rethrowUnrecorded(error: unknown): void {
  if (error instanceof AggregateError) return;
  throw error;
}
