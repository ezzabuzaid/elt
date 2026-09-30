import { randomUUID } from 'node:crypto';
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
// releases it when its connection closes or its process exits. null when
// another server holds it, or it cannot be opened now.
function lease(directory: string): DatabaseSync | null {
  let database: DatabaseSync | undefined;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    database = new DatabaseSync(join(directory, 'watch.sqlite'));
    database.exec('BEGIN IMMEDIATE');
    return database;
  } catch {
    database?.close();
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

// Whether a newer plugin server is running, after recording this server as
// running. A server that stopped cleanly removed itself; one that crashed
// stops counting once its heartbeat is ten seconds old.
function outdated(directory: string, id: string, version: string): boolean {
  const newer = (candidate: string) => {
    const [left, right] = [candidate, version].map((value) =>
      value.split('.').map(Number),
    );
    for (let part = 0; part < 3; part++)
      if (left?.[part] !== right?.[part])
        return (left?.[part] ?? 0) > (right?.[part] ?? 0);
    return false;
  };
  try {
    using settings = new Settings(directory);
    const now = Date.now();
    settings.heartbeat(id, version, now);
    return settings.runningVersions(now - 10_000).some(newer);
  } catch {
    return false;
  }
}

// Aborts changed once the saved selection differs from selection, and
// newer once a newer server is running.
async function followSelection(
  directory: string,
  selection: string,
  id: string,
  version: string,
  changed: AbortController,
  newer: AbortController,
  signal: AbortSignal,
) {
  try {
    for await (const _ of setInterval(1_000, undefined, { signal }))
      try {
        if (outdated(directory, id, version)) newer.abort();
        else if (JSON.stringify(readConfiguration(directory)) !== selection)
          changed.abort();
      } catch {
        // Unreadable for now, such as while the disk is full: ask again.
      }
  } catch {
    // Aborted: the selection changed, a newer server runs, or the watch ended.
  }
}

// Waits until this server may lead: no newer server runs and the lease is free.
async function acquire(
  directory: string,
  id: string,
  version: string,
  signal: AbortSignal,
): Promise<DatabaseSync | null> {
  for (;;) {
    if (!outdated(directory, id, version)) {
      const held = lease(directory);
      if (held !== null) return held;
    }
    try {
      await sleep(2_000, undefined, { signal });
    } catch {
      return null;
    }
  }
}

// Leads until the server stops or a newer server starts, which then leads.
async function lead(
  directory: string,
  id: string,
  version: string,
  signal: AbortSignal,
) {
  const newer = new AbortController();
  const leading = AbortSignal.any([signal, newer.signal]);
  while (!leading.aborted) {
    const changed = new AbortController();
    const watching = AbortSignal.any([leading, changed.signal]);
    let following = Promise.resolve();
    try {
      const configuration = readConfiguration(directory);
      following = followSelection(
        directory,
        JSON.stringify(configuration),
        id,
        version,
        changed,
        newer,
        watching,
      );
      removeStaleImports(directory, configuration);
      if (configuration !== null)
        await watchImports(directory, configuration, watching);
    } catch {
      // Retried below, once the selection changes or a minute passes.
    }
    await sleep(60_000, undefined, { signal: watching }).catch(() => {});
    changed.abort();
    await following;
  }
}

// While this server runs, keeps every selected app's import current. One
// server per Mac leads, the newest plugin version first; the others wait to
// take over. A changed selection, from any chat, restarts the watch; a watch
// whose sources all stopped, such as for a missing permission, retries after
// a minute. It never throws: a failure outside any pass, such as a full disk,
// is retried too, so the plugin's tools keep working.
export async function keepFresh(
  directory: string,
  signal: AbortSignal,
  version: string,
): Promise<void> {
  const id = randomUUID();
  try {
    while (!signal.aborted) {
      const leader = await acquire(directory, id, version, signal);
      if (leader === null) return;
      using _lease = leader;
      await lead(directory, id, version, signal);
    }
  } finally {
    try {
      using settings = new Settings(directory);
      settings.forgetServer(id);
    } catch {
      // Unreachable settings: the heartbeat goes stale on its own.
    }
  }
}
