import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setInterval, setTimeout as sleep } from 'node:timers/promises';
import { Pipeline } from 'elt';
import { installSQLiteCatalog, SQLiteSyncHistory } from 'elt-sqlite';
import {
  type Configuration,
  importDirectory,
  removeStaleImports,
  Settings,
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

function readConfiguration(directory: string): Configuration | null {
  using settings = new Settings(directory);
  return settings.configuration();
}

// Watches the selected apps until the signal aborts: every app's first pass
// loads it, then each source's own watcher decides when to sync again. Each
// pass is recorded in its app's data.sqlite, beside the catalog readers query;
// an app whose connection cannot be built has no pipeline to record it, so its
// failure is kept in the settings until it builds.
async function watchImports(
  directory: string,
  configuration: Configuration,
  signal: AbortSignal,
) {
  const imports = [];
  for (const item of configuration.apps) {
    const importPath = importDirectory(directory, item);
    try {
      imports.push(await appConnection(directory, item));
      using settings = new Settings(directory);
      settings.clearConnectionFailure(importPath);
    } catch (error) {
      using settings = new Settings(directory);
      settings.saveConnectionFailure(
        importPath,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (imports.length === 0) return;
  const history = new SQLiteSyncHistory();
  const destinations = imports.map(({ destination }) => destination);
  await history.install(destinations);
  for (const destination of destinations) installSQLiteCatalog(destination);
  const pipeline = new Pipeline({
    connections: imports.map(({ connection }) => connection),
    history,
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
