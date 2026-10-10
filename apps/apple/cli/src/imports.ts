import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  FlightFailedError,
  FlightInterruptedError,
  SingleFlight,
} from '@zukhruf/single-flight';

import type {
  AppleConnector,
  ChoiceOptions,
} from '@workspace/connector-apple-connector/apple-connector';
import { userConnectors } from '@workspace/connector-apple-manifest/user-connectors';
import {
  type PassState,
  readPassStatus,
  readSQLite,
} from '@workspace/elt-sqlite';
import { type Selection, Settings } from '@workspace/settings';

import {
  ObservedHistory,
  type PassObserver,
  type PassSummary,
  type SyncLine,
  failed,
} from './sync.ts';

// Shows a sync from its start to its finish or interruption, each pass in
// between, each import whose pass another sync runs, which this one waits for,
// and each import it did not finish: removed, another setup removed its
// connector while it ran; interrupted, the sync it waited for stopped first.
export type SyncObserver = PassObserver & {
  start(): void;
  joined(connector: AppleConnector): void;
  skipped(connector: AppleConnector, why: 'removed' | 'interrupted'): void;
  finish(): void;
  interrupted(): void;
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
  // importing it now stops, and the next setup or sync removes that import.
  async select(selections: readonly Selection[]): Promise<void> {
    using settings = new Settings(this.root);
    settings.select(selections, {
      facts: (name) => this.connector(name),
      permissions: ({ connector }) => this.connector(connector).guidance(),
    });
    await using flights = this.#flights();
    await removeStale(settings, flights);
  }

  // Where every setup and sync of these imports meets the others: a pass of
  // an import runs in one of them at a time, and the rest wait for its lines.
  #flights(): SingleFlight<readonly SyncLine[]> {
    return new SingleFlight({
      directory: this.root,
      codec: { encode: JSON.stringify, decode: JSON.parse },
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
  // the observer, once the imports no longer selected are removed. A sync that
  // finds another sync running an import's pass waits for that pass and shows
  // it instead of running its own. Ctrl-C or SIGTERM stops a sync at once:
  // what it committed stays and its checkpoints resume it. A pass that did not
  // load completely, or one it waited for whose sync stopped first, leaves
  // exit status 1; a connector another setup removed meanwhile does not.
  async sync(
    only: readonly string[] | undefined,
    observer: SyncObserver,
  ): Promise<void> {
    using settings = new Settings(this.root);
    const selections = settings.selections();
    if (selections.length === 0)
      throw new Error('No connectors are set up; run: setup');
    await using flights = this.#flights();
    await removeStale(settings, flights);
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
        settings.saveConnectionFailure(selection, unloaded(name), 'system');
        unsynced = true;
      } else imports.push({ connector, selection });
    }
    // The signal ends the process the default way: process.exit would first
    // wait for a source stuck in a filesystem call, such as a pipe no one
    // writes, and never return. A listener left for the signal, such as this
    // sync's own when clack exits, would take it instead, and it would be lost.
    const interrupt = (signal: NodeJS.Signals) => {
      observer.interrupted();
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    // In a terminal clack's spinner reads Ctrl-C itself and exits with 0,
    // which no finished sync does.
    const cancelled = (code: number) => {
      if (code === 0) interrupt('SIGINT');
    };
    process.on('exit', cancelled);
    const passes: PassSummary[] = [];
    const show = (connector: AppleConnector, line: SyncLine) => {
      if (line.status === 'removed' || line.status === 'interrupted') {
        if (line.status === 'interrupted') unsynced = true;
        observer.skipped(connector, line.status);
      } else {
        passes.push(line);
        observer.passed(connector, line);
      }
    };
    observer.start();
    try {
      await Promise.all(
        imports.map(async ({ connector, selection }) => {
          // What this sync shows of its own pass, for the syncs that wait on it.
          const lines: SyncLine[] = [];
          const own = (line: SyncLine) => {
            lines.push(line);
            show(connector, line);
          };
          try {
            const { value, joined } = await flights.run(
              settings.directory(selection),
              async () => {
                const outcome = await connector.import(
                  settings,
                  selection,
                  new ObservedHistory(connector, {
                    progress: (...args) => observer.progress(...args),
                    passed: (_, summary) => own(summary),
                  }),
                );
                if (outcome.status === 'unconnected')
                  own(failed(connector, outcome.error, 0));
                else if (outcome.status === 'removed')
                  own({ connector: connector.name, status: 'removed' });
                return lines;
              },
              { onJoin: () => observer.joined(connector) },
            );
            if (joined) for (const line of value) show(connector, line);
          } catch (error) {
            if (error instanceof FlightInterruptedError)
              show(connector, {
                connector: connector.name,
                status: 'interrupted',
              });
            else if (error instanceof FlightFailedError)
              show(connector, failed(connector, error.failure.message, 0));
            else throw error;
          }
        }),
      );
    } finally {
      process.off('exit', cancelled);
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
  status(): ConnectorStatus[] {
    using settings = new Settings(this.root);
    return settings.selections().map((selection) => {
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
          error: connector.failure(
            new Error(failure.error),
            failure.failureType,
          ),
        };
      const { pass, streams } = readPassStatus(path);
      // Not synced yet, or no pass began.
      if (pass === null) return never;
      return {
        ...base,
        state: pass.state,
        completedAt: pass.completedAt,
        lastSuccessAt: pass.lastSucceededAt,
        error:
          pass.error === null
            ? null
            : connector.failure(new Error(pass.error), pass.failureType),
        streams: streams.map(({ stream, state, lastSucceededAt }) => ({
          stream,
          state,
          lastSuccessAt: lastSucceededAt,
        })),
      };
    });
  }
}

// Why a selected connector cannot be used, and what to do about it.
function unloaded(name: string): string {
  return `No connector named ${name} is loaded: fix or restore its folder in ${userConnectors}, or set up without it.`;
}

// Removes each import the selection no longer names, unless a sync runs its
// pass now: joining that pass's flight gives up the wait at once, and the next
// setup or sync removes it. While a removal runs, a sync of the import waits.
// The plugin's importPending removes stale imports the same way.
async function removeStale(
  settings: Settings,
  flights: SingleFlight<readonly SyncLine[]>,
): Promise<void> {
  for (const directory of settings.staleImports()) {
    const joined = new AbortController();
    await flights
      .run(
        directory,
        async () => {
          rmSync(directory, { recursive: true, force: true });
          return [];
        },
        { onJoin: () => joined.abort(), signal: joined.signal },
      )
      .catch((error: unknown) => {
        if (!joined.signal.aborted) throw error;
      });
  }
}
