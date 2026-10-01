import { randomUUID } from 'node:crypto';
import { setInterval, setTimeout as sleep } from 'node:timers/promises';
import { Pipeline } from 'elt';
import { installSQLiteCatalog, SQLiteSyncHistory } from 'elt-sqlite';
import { ImportStore, lease } from 'import-store';
import { type Configuration, configurationSchema } from './apple-plugin.ts';
import { forgetServer, outdated } from './leadership.ts';
import { appConnection } from './sync.ts';

function readConfiguration(directory: string): Configuration {
  using store = new ImportStore(directory);
  return configurationSchema.parse({ apps: store.selections() });
}

// Republishes what readers see in the settings file, removes imports no
// longer selected, and rolls back what a pass stopped mid-commit left, so
// readers that cannot write can open every import before this server's
// first pass.
function tidy(directory: string) {
  using store = new ImportStore(directory);
  store.publish();
  store.removeStaleImports();
  for (const selection of store.selections()) store.recover(selection);
}

// Watches the selected apps until the signal aborts: every app's first pass
// loads it, then each source's own watcher decides when to sync again. Each
// pass is recorded in its app's data.sqlite, beside the catalog readers query;
// an app whose connection cannot be built has no pipeline to record it, so its
// failure is kept in the store's settings until it builds.
async function watchImports(
  directory: string,
  configuration: Configuration,
  signal: AbortSignal,
) {
  const imports = [];
  for (const item of configuration.apps)
    try {
      imports.push(await appConnection(directory, item));
      using store = new ImportStore(directory);
      store.clearConnectionFailure(item);
    } catch (error) {
      using store = new ImportStore(directory);
      store.saveConnectionFailure(
        item,
        error instanceof Error ? error.message : String(error),
      );
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
): Promise<Disposable | null> {
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
      tidy(directory);
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
      forgetServer(directory, id);
    } catch {
      // Unreachable settings: the heartbeat goes stale on its own.
    }
  }
}
