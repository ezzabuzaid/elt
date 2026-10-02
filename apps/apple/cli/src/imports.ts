import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppleApp, ChoiceOptions } from 'apple/apps/apple-app';
import { ImportStore, lease, leaseHeld, type Selection } from 'import-store';
import { type PassObserver, type PassSummary, syncImports } from './sync.ts';

// Shows a sync from its start to its finish, and each pass in between.
export type SyncObserver = PassObserver & {
  start(): void;
  finish(): void;
};

export type { Selection };

export class StoreBusyError extends Error {
  override name = 'StoreBusyError';
  constructor() {
    super('Another sync is using this store. Wait for it, or stop it first.');
  }
}

export type AppStatus = {
  readonly app: string;
  readonly selection: string;
  readonly database: string | null;
  // never: not synced yet; interrupted: a pass was running when its sync stopped.
  readonly state:
    | 'never'
    | 'running'
    | 'interrupted'
    | 'succeeded'
    | 'partial'
    | 'failed';
  readonly completedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly error: string | null;
  readonly streams: readonly {
    readonly stream: string;
    readonly state: string;
    readonly lastSuccessAt: string | null;
  }[];
};

// The CLI's imports under outputs/cli: the mediator
// every command goes through. It knows the Apple apps and keeps their imports
// in import-store, where settings.sqlite holds the selection and each
// selection's folder its data.sqlite, checkpoints and attachment files. One
// sync or selection change writes at a time; another is refused, not queued.
// Everything here can be rebuilt by syncing again.
export class Imports {
  readonly root = resolve('outputs/cli');

  constructor(readonly apps: readonly AppleApp[]) {}

  get names(): string[] {
    return this.apps.map(({ name }) => name);
  }

  app(name: string): AppleApp {
    const app = this.apps.find((candidate) => candidate.name === name);
    if (app === undefined) throw new Error(`Unknown app ${name}`);
    return app;
  }

  // What an app can be narrowed to; opening it is also what makes macOS ask
  // for access.
  async options(name: string): Promise<ChoiceOptions[]> {
    const app = this.app(name);
    return app.listChoices().catch((error: unknown) => {
      throw new Error(app.failure(error));
    });
  }

  selections(): Selection[] {
    using store = new ImportStore(this.root);
    return store.selections();
  }

  // Replaces the selection. An app that left it, or whose scope changed, loses
  // its import, so the next sync reads it again from the start.
  select(selections: readonly Selection[]): void {
    using _ = this.#lease();
    using store = new ImportStore(this.root);
    store.select(selections, {
      facts: (name) => this.app(name),
      permissions: ({ app }) => this.app(app).guidance(),
    });
  }

  // Opens an app's import for reading only; nothing a reader runs can write
  // to it, and what a sync stopped mid-commit left is rolled back first.
  read(name: string): DatabaseSync {
    const { title } = this.app(name);
    using store = new ImportStore(this.root);
    const selection = store.selections().find(({ app }) => app === name);
    if (selection === undefined)
      throw new Error(`${title} is not set up; run: setup`);
    if (!existsSync(store.database(selection)))
      throw new Error(`${title} has not synced yet; run: sync`);
    return store.read(selection);
  }

  // One pass of each selected app, or only of those named, or with watch a
  // first pass and then one for each change, shown through the observer.
  // Ctrl-C stops a sync, watching or not, at once: what it committed stays,
  // its checkpoints resume it, and status shows the pass as interrupted. In
  // a terminal clack's spinner takes Ctrl-C itself and exits with 0, so the
  // exit status is set as the process exits. A pass that did not load
  // completely leaves exit status 1.
  async sync(
    only: readonly string[] | undefined,
    watch: boolean,
    observer: SyncObserver,
  ): Promise<void> {
    using _ = this.#lease();
    using store = new ImportStore(this.root);
    const selections = store.selections();
    if (selections.length === 0)
      throw new Error('No apps are set up; run: setup');
    const imports = (only ?? selections.map(({ app }) => app)).map((name) => {
      const selection = selections.find(({ app }) => app === name);
      if (selection === undefined)
        throw new Error(`${name} is not set up; run: setup`);
      return { app: this.app(name), selection };
    });
    const interrupted = () => {
      process.exitCode = 130;
    };
    process.on('exit', interrupted);
    process.once('SIGINT', () => process.exit(130));
    process.once('SIGTERM', () => process.exit(130));
    const passes: PassSummary[] = [];
    observer.start();
    try {
      await syncImports(store, imports, watch, {
        progress: (app, progress) => observer.progress(app, progress),
        passed: (app, summary) => {
          passes.push(summary);
          observer.passed(app, summary);
        },
      });
    } finally {
      process.off('exit', interrupted);
    }
    observer.finish();
    process.exitCode = passes.every(({ status }) => status === 'succeeded')
      ? 0
      : 1;
  }

  // Each selected app as its own data.sqlite records it: the latest pass, the
  // last successful one, and every stream's own latest outcome; or why its
  // connection could not be built, which no pass recorded.
  status(): AppStatus[] {
    const syncing = leaseHeld(this.root);
    using store = new ImportStore(this.root);
    return store.selections().map((selection) => {
      const app = this.app(selection.app);
      const path = store.database(selection);
      const base = {
        app: app.name,
        selection: app.describe(selection.scope),
        database: existsSync(path) ? path : null,
      };
      const never = {
        ...base,
        state: 'never' as const,
        completedAt: null,
        lastSuccessAt: null,
        error: null,
        streams: [],
      };
      const failure = store.connectionFailure(selection);
      if (failure !== undefined)
        return {
          ...never,
          state: 'failed' as const,
          completedAt: failure.failedAt,
          error: app.failure(new Error(failure.error)),
        };
      if (base.database === null) return never;
      // A sync installs the history views before it writes anything else.
      using database = store.read(selection);
      const latest = database
        .prepare(
          'SELECT status, completed_at, error, last_successful_sync_at FROM sync_status WHERE connector = ?',
        )
        .get(app.name) as
        | {
            status: AppStatus['state'];
            completed_at: string | null;
            error: string | null;
            last_successful_sync_at: string | null;
          }
        | undefined;
      // Installed, but no pass began yet.
      if (latest === undefined) return never;
      return {
        ...base,
        state:
          latest.status === 'running' && !syncing
            ? 'interrupted'
            : latest.status,
        completedAt: latest.completed_at,
        lastSuccessAt: latest.last_successful_sync_at,
        error: latest.error,
        streams: (
          database
            .prepare(
              'SELECT stream, status, last_successful_sync_at FROM stream_status WHERE connector = ? ORDER BY stream',
            )
            .all(app.name) as {
            stream: string;
            status: string;
            last_successful_sync_at: string | null;
          }[]
        ).map(({ stream, status, last_successful_sync_at }) => ({
          stream,
          state: status,
          lastSuccessAt: last_successful_sync_at,
        })),
      };
    });
  }

  // The one writer of this store; the operating system releases it when this
  // process exits.
  #lease(): Disposable {
    const held = lease(this.root);
    if (held === null) throw new StoreBusyError();
    return held;
  }
}
