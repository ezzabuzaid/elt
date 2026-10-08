import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type {
  AppleConnector,
  ChoiceOptions,
} from '@workspace/connector-apple-connector/apple-connector';
import { userConnectors } from '@workspace/connector-apple-manifest/user-connectors';
import {
  type PassState,
  SQLitePasses,
  readSQLite,
} from '@workspace/elt-sqlite';
import { type Selection, Settings } from '@workspace/settings';

import {
  ObservedHistory,
  type PassObserver,
  type PassSummary,
  failed,
} from './sync.ts';

// Shows a sync from its start to its finish, each pass in between, and each
// import it did not run: busy, another sync imports it; removed, another setup
// removed its connector while it ran.
export type SyncObserver = PassObserver & {
  start(): void;
  skipped(connector: AppleConnector, why: 'busy' | 'removed'): void;
  finish(): void;
};

export type { Selection };

export type ConnectorStatus = {
  readonly connector: string;
  readonly title: string;
  readonly selection: string;
  readonly database: string | null;
  // never: not synced yet.
  readonly state: 'never' | PassState;
  readonly completedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly error: string | null;
  readonly streams: readonly {
    readonly stream: string;
    readonly state: PassState;
    readonly lastSuccessAt: string | null;
  }[];
};

// The CLI's imports under outputs/cli: the mediator every command goes
// through. It knows the Apple connectors and keeps their selection in
// settings.sqlite and each selection's import in its own folder: data.sqlite,
// checkpoints and attachment files. Everything here can be rebuilt by syncing
// again.
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
    using settings = new Settings(this.root);
    return settings.selections();
  }

  // Replaces the selection. A connector that left it, or whose scope changed,
  // loses its import, so the next sync reads it again from the start; a sync
  // importing it now stops.
  async select(selections: readonly Selection[]): Promise<void> {
    using settings = new Settings(this.root);
    await settings.select(selections, {
      facts: (name) => this.connector(name),
      permissions: ({ connector }) => this.connector(connector).guidance(),
    });
  }

  // Opens a connector's import for reading only; nothing a reader runs can
  // write to it, and what a sync stopped mid-commit left is rolled back first.
  read(name: string): DatabaseSync {
    const { title } = this.connector(name);
    using settings = new Settings(this.root);
    const selection = settings
      .selections()
      .find(({ connector }) => connector === name);
    if (selection === undefined)
      throw new Error(`${title} is not set up; run: setup`);
    if (!existsSync(settings.database(selection)))
      throw new Error(`${title} has not synced yet; run: sync`);
    return readSQLite(settings.database(selection));
  }

  // One pass of each selected connector, or only of those named, shown through
  // the observer. Ctrl-C stops a sync at once: what it committed stays, its
  // checkpoints resume it, and status shows the pass as interrupted. In a
  // terminal clack's spinner takes Ctrl-C itself and exits with 0, so the exit
  // status is set as the process exits. A pass that did not load completely,
  // or an import another sync was running, leaves exit status 1; a connector
  // another setup removed meanwhile does not.
  async sync(
    only: readonly string[] | undefined,
    observer: SyncObserver,
  ): Promise<void> {
    using settings = new Settings(this.root);
    const selections = settings.selections();
    if (selections.length === 0)
      throw new Error('No connectors are set up; run: setup');
    const imports = [];
    // A selected connector that is not loaded cannot sync; status says so,
    // and the others still sync.
    let unsynced = false;
    for (const name of only ?? selections.map(({ connector }) => connector)) {
      const selection = selections.find(({ connector }) => connector === name);
      if (selection === undefined)
        throw new Error(`${name} is not set up; run: setup`);
      const connector = this.#loaded(name);
      if (connector === undefined) {
        settings.saveConnectionFailure(selection, unloaded(name));
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
    const passed = (connector: AppleConnector, summary: PassSummary) => {
      passes.push(summary);
      observer.passed(connector, summary);
    };
    const history = new ObservedHistory(
      imports.map(({ connector }) => connector),
      { progress: (...args) => observer.progress(...args), passed },
    );
    observer.start();
    try {
      await Promise.all(
        imports.map(async ({ connector, selection }) => {
          const outcome = await connector.import(settings, selection, history);
          if (outcome.status === 'unconnected')
            passed(connector, failed(connector, outcome.error, 0));
          else if (outcome.status !== 'imported') {
            if (outcome.status === 'busy') unsynced = true;
            observer.skipped(connector, outcome.status);
          }
        }),
      );
    } finally {
      process.off('exit', interrupted);
    }
    observer.finish();
    process.exitCode =
      !unsynced &&
      passes.every(({ status }) => ['succeeded', 'cancelled'].includes(status))
        ? 0
        : 1;
  }

  // Each selected connector as its own data.sqlite records it: the latest
  // pass, the last successful one, and every stream's own latest outcome; or
  // why its connection could not be built, which no pass recorded.
  async status(): Promise<ConnectorStatus[]> {
    using settings = new Settings(this.root);
    return Promise.all(
      settings.selections().map(async (selection) => {
        const connector = this.#loaded(selection.connector);
        const path = settings.database(selection);
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
        const failure = settings.connectionFailure(selection);
        if (failure !== undefined)
          return {
            ...never,
            state: 'failed' as const,
            completedAt: failure.failedAt,
            error: connector.failure(new Error(failure.error)),
          };
        const { pass, streams } = await new SQLitePasses(path).status();
        // Not synced yet, or no pass began.
        if (pass === null) return never;
        return {
          ...base,
          state: pass.state,
          completedAt: pass.completedAt,
          lastSuccessAt: pass.lastSucceededAt,
          error: pass.error,
          streams: streams.map(({ stream, state, lastSucceededAt }) => ({
            stream,
            state,
            lastSuccessAt: lastSucceededAt,
          })),
        };
      }),
    );
  }
}

// Why a selected connector cannot be used, and what to do about it.
function unloaded(name: string): string {
  return `No connector named ${name} is loaded: fix or restore its folder in ${userConnectors}, or set up without it.`;
}
