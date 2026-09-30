import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setInterval, setTimeout as sleep } from 'node:timers/promises';
import {
  type Connection,
  type CopyOutcome,
  Pipeline,
  passError,
  passStatus,
  type RecordedPass,
  SyncHistory,
  type Target,
} from 'elt';
import { type App, apps } from './apps.ts';
import {
  type Configuration,
  importDirectory,
  removeStaleImports,
  Settings,
  type SyncResult,
} from './settings.ts';
import { appConnection } from './sync.ts';

// The lock of the one server per Mac that keeps imports current. SQLite
// releases it when its connection closes or its process exits.
function lease(directory: string): DatabaseSync | null {
  const database = new DatabaseSync(join(directory, 'watch.sqlite'));
  try {
    database.exec('BEGIN IMMEDIATE');
    return database;
  } catch {
    database.close();
    return null;
  }
}

export function leaderRunning(directory: string): boolean {
  const held = lease(directory);
  held?.close();
  return held === null;
}

const failure = (app: App, error: unknown) =>
  `${error instanceof Error ? error.message : String(error)} ${apps[app].permissions}`;

function save(directory: string, importPath: string, result: SyncResult) {
  using settings = new Settings(directory);
  settings.saveSyncResult(importPath, result);
}

function lastSuccess(directory: string, importPath: string) {
  using settings = new Settings(directory);
  return settings.syncResult(importPath)?.lastSucceededAt;
}

// Each pass of an app, recorded as its import's status for apple_status.
class ImportHistory<T extends Target> extends SyncHistory<T> {
  constructor(
    readonly directory: string,
    readonly configuration: Configuration,
  ) {
    super();
  }

  override async begin(connection: Connection<T>): Promise<RecordedPass<T>> {
    const item = this.configuration.apps.find(
      ({ app }) => app === connection.name,
    );
    if (item === undefined)
      throw new TypeError(`No selected app for connection ${connection.name}`);
    const importPath = importDirectory(this.directory, item);
    const startedAt = new Date().toISOString();
    const lastSucceededAt = lastSuccess(this.directory, importPath);
    save(this.directory, importPath, {
      state: 'running',
      startedAt,
      lastSucceededAt,
    });
    return {
      finish: async (outcomes: readonly CopyOutcome<T>[]) => {
        const finishedAt = new Date().toISOString();
        const state = passStatus(outcomes);
        const error = passError(outcomes);
        save(this.directory, importPath, {
          state,
          startedAt,
          finishedAt,
          lastSucceededAt: state === 'succeeded' ? finishedAt : lastSucceededAt,
          ...(error !== null && { error: failure(item.app, error) }),
          streams: outcomes.map(({ copy, count, deleted, failures }) => ({
            name: copy.from.name,
            count,
            deleted,
            ...(failures.length > 0 && {
              errors: failures.map(({ error }) => String(error)),
            }),
          })),
        });
      },
      fail: async (error: unknown) => {
        save(this.directory, importPath, {
          state: 'failed',
          startedAt,
          finishedAt: new Date().toISOString(),
          lastSucceededAt,
          error: failure(item.app, error),
        });
      },
    };
  }
}

function readConfiguration(directory: string): Configuration | null {
  using settings = new Settings(directory);
  return settings.configuration();
}

// Watches the selected apps until the signal aborts: every app's first pass
// loads it, then each source's own watcher decides when to sync again.
async function watchImports(
  directory: string,
  configuration: Configuration,
  signal: AbortSignal,
) {
  const connections = [];
  for (const item of configuration.apps)
    try {
      connections.push(await appConnection(directory, item));
    } catch (error) {
      const now = new Date().toISOString();
      save(directory, importDirectory(directory, item), {
        state: 'failed',
        startedAt: now,
        finishedAt: now,
        error: failure(item.app, error),
      });
    }
  if (connections.length === 0) return;
  const pipeline = new Pipeline({
    connections,
    history: new ImportHistory(directory, configuration),
  });
  try {
    for await (const _pass of pipeline.watch({ signal }));
  } catch {
    // Every failure is recorded against its app by the history.
  }
}

// While this server runs, keeps every selected app's import current. One
// server per Mac leads; the others wait to take over when it exits. A changed
// selection, from any chat, restarts the watch; a watch whose sources all
// stopped, such as for a missing permission, retries after a minute.
export async function keepFresh(
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let leader = lease(directory);
  while (leader === null) {
    try {
      await sleep(2_000, undefined, { signal });
    } catch {
      return;
    }
    leader = lease(directory);
  }
  using _lease = leader;
  while (!signal.aborted) {
    const configuration = readConfiguration(directory);
    const selection = JSON.stringify(configuration);
    const changed = new AbortController();
    const watching = AbortSignal.any([signal, changed.signal]);
    const polling = (async () => {
      try {
        for await (const _ of setInterval(1_000, undefined, {
          signal: watching,
        }))
          if (JSON.stringify(readConfiguration(directory)) !== selection)
            changed.abort();
      } catch {
        // Aborted: the selection changed or the server is stopping.
      }
    })();
    try {
      removeStaleImports(directory, configuration);
      if (configuration !== null)
        await watchImports(directory, configuration, watching);
      await sleep(60_000, undefined, { signal: watching }).catch(() => {});
    } finally {
      changed.abort();
      await polling;
    }
  }
}
