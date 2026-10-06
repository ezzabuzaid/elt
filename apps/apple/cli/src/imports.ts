import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type {
  AppleConnector,
  ChoiceOptions,
} from '@workspace/connector-apple-connector/apple-connector';
import { userConnectors } from '@workspace/connector-apple-manifest/user-connectors';
import {
  ImportStore,
  type Pass,
  type Selection,
  lease,
  leaseHeld,
} from '@workspace/import-store';

import { type PassObserver, type PassSummary, syncImports } from './sync.ts';

// Shows a sync from its start to its finish, and each pass in between.
export type SyncObserver = PassObserver & {
  start(): void;
  finish(): void;
};

export type { Selection };

// How long a sync or setup waits for the store's lease: longer than a status
// check holds it to look, while a running sync, which holds it for its whole
// pass, still refuses a second one.
const leaseWaitMs = 5_000;

export class StoreBusyError extends Error {
  override name = 'StoreBusyError';
  constructor() {
    super('Another sync is using this store. Wait for it, or stop it first.');
  }
}

// Where a pass or one of its streams got to; interrupted: it was running when
// its sync stopped.
type Progress = Pass['state'] | 'interrupted';

export type ConnectorStatus = {
  readonly connector: string;
  readonly title: string;
  readonly selection: string;
  readonly database: string | null;
  // never: not synced yet.
  readonly state: 'never' | Progress;
  readonly completedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly error: string | null;
  readonly streams: readonly {
    readonly stream: string;
    readonly state: Progress;
    readonly lastSuccessAt: string | null;
  }[];
};

// The CLI's imports under outputs/cli: the mediator every command goes
// through. It knows the Apple connectors and keeps their imports in
// import-store, where settings.sqlite holds the selection and each
// selection's folder its data.sqlite, checkpoints and attachment files. One
// sync or selection change writes at a time; another is refused, not queued.
// Everything here can be rebuilt by syncing again.
export class Imports {
  readonly root = resolve('outputs/cli');
  readonly connectors: readonly AppleConnector[];

  constructor(connectors: readonly AppleConnector[]) {
    this.connectors = connectors;
  }

  get names(): string[] {
    return this.connectors.map(({ name }) => name);
  }

  connector(name: string): AppleConnector {
    const connector = this.#loaded(name);
    if (connector === undefined) throw new Error(`Unknown connector ${name}`);
    return connector;
  }

  #loaded(name: string): AppleConnector | undefined {
    return this.connectors.find((candidate) => candidate.name === name);
  }

  // What a connector can be narrowed to; opening it is also what makes macOS
  // ask for access.
  async options(name: string): Promise<ChoiceOptions[]> {
    const connector = this.connector(name);
    return connector.listChoices().catch((error: unknown) => {
      throw new Error(connector.failure(error));
    });
  }

  selections(): Selection[] {
    using store = new ImportStore(this.root);
    return store.selections();
  }

  // Replaces the selection. A connector that left it, or whose scope changed,
  // loses its import, so the next sync reads it again from the start.
  select(selections: readonly Selection[]): void {
    using _ = this.#lease();
    using store = new ImportStore(this.root);
    store.select(selections, {
      facts: (name) => this.connector(name),
      permissions: ({ connector }) => this.connector(connector).guidance(),
    });
  }

  // Opens a connector's import for reading only; nothing a reader runs can
  // write to it, and what a sync stopped mid-commit left is rolled back first.
  read(name: string): DatabaseSync {
    const { title } = this.connector(name);
    using store = new ImportStore(this.root);
    const selection = store
      .selections()
      .find(({ connector }) => connector === name);
    if (selection === undefined)
      throw new Error(`${title} is not set up; run: setup`);
    if (!existsSync(store.database(selection)))
      throw new Error(`${title} has not synced yet; run: sync`);
    return store.read(selection);
  }

  // One pass of each selected connector, or only of those named, shown through
  // the observer. Ctrl-C stops a sync at once: what it committed stays, its
  // checkpoints resume it, and status shows the pass as interrupted. In a
  // terminal clack's spinner takes Ctrl-C itself and exits with 0, so the exit
  // status is set as the process exits. A pass that did not load completely
  // leaves exit status 1.
  async sync(
    only: readonly string[] | undefined,
    observer: SyncObserver,
  ): Promise<void> {
    using _ = this.#lease();
    using store = new ImportStore(this.root);
    const selections = store.selections();
    if (selections.length === 0)
      throw new Error('No connectors are set up; run: setup');
    const imports = [];
    // A selected connector that is not loaded cannot sync; status says
    // so, and the others still sync.
    let unsynced = false;
    for (const name of only ?? selections.map(({ connector }) => connector)) {
      const selection = selections.find(({ connector }) => connector === name);
      if (selection === undefined)
        throw new Error(`${name} is not set up; run: setup`);
      const connector = this.#loaded(name);
      if (connector === undefined) {
        store.saveConnectionFailure(selection, unloaded(name));
        unsynced = true;
      } else imports.push({ connector, selection });
    }
    const interrupted = () => {
      process.exitCode = 130;
    };
    process.on('exit', interrupted);
    process.once('SIGINT', () => process.exit(130));
    process.once('SIGTERM', () => process.exit(130));
    const passes: PassSummary[] = [];
    observer.start();
    try {
      await syncImports(store, imports, {
        progress: (connector, progress) =>
          observer.progress(connector, progress),
        passed: (connector, summary) => {
          passes.push(summary);
          observer.passed(connector, summary);
        },
      });
    } finally {
      process.off('exit', interrupted);
    }
    observer.finish();
    process.exitCode =
      !unsynced && passes.every(({ status }) => status === 'succeeded') ? 0 : 1;
  }

  // Each selected connector as its own data.sqlite records it: the latest
  // pass, the last successful one, and every stream's own latest outcome; or
  // why its connection could not be built, which no pass recorded.
  status(): ConnectorStatus[] {
    const syncing = leaseHeld(this.root);
    using store = new ImportStore(this.root);
    return store.selections().map((selection) => {
      const connector = this.#loaded(selection.connector);
      const path = store.database(selection);
      const base = {
        connector: selection.connector,
        title: connector?.title ?? selection.connector,
        selection:
          connector?.describe(selection.scope) ?? 'its saved selection',
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
      if (connector === undefined)
        return {
          ...never,
          state: 'failed' as const,
          error: unloaded(selection.connector),
        };
      const failure = store.connectionFailure(selection);
      if (failure !== undefined)
        return {
          ...never,
          state: 'failed' as const,
          completedAt: failure.failedAt,
          error: connector.failure(new Error(failure.error)),
        };
      const latest = store.latestPass(selection);
      // Not synced yet, or no pass began.
      if (latest === null) return never;
      const progress = (state: Pass['state']): Progress =>
        state === 'running' && !syncing ? 'interrupted' : state;
      return {
        ...base,
        state: progress(latest.state),
        completedAt: latest.completedAt,
        lastSuccessAt: latest.lastSucceededAt,
        error: latest.error,
        streams: store
          .streamStatuses(selection)
          .map(({ stream, state, lastSucceededAt }) => ({
            stream,
            state: progress(state),
            lastSuccessAt: lastSucceededAt,
          })),
      };
    });
  }

  // The one writer of this store; the operating system releases it when this
  // process exits.
  #lease(): Disposable {
    const held = lease(this.root, leaseWaitMs);
    if (held === null) throw new StoreBusyError();
    return held;
  }
}

// Why a selected connector cannot be used, and what to do about it.
function unloaded(name: string): string {
  return `No connector named ${name} is loaded: fix or restore its folder in ${userConnectors}, or set up without it.`;
}
