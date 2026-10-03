import { setInterval, setTimeout as sleep } from 'node:timers/promises';

import { Pipeline } from '@workspace/elt';
import { SQLiteSyncHistory, installSQLiteCatalog } from '@workspace/elt-sqlite';
import {
  ImportStore,
  type Selection,
  importDirectory,
  lease,
} from '@workspace/import-store';

import type { ApplePlugin } from './apple-plugin.ts';

function readSelections(directory: string): Selection[] {
  using store = new ImportStore(directory);
  return store.selections();
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
  plugin: ApplePlugin,
  selections: readonly Selection[],
  signal: AbortSignal,
) {
  const { directory } = plugin;
  const imports = [];
  for (const item of selections)
    try {
      imports.push(
        await plugin
          .app(item.app)
          .connection(importDirectory(directory, item), item),
      );
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
// updated once another plugin version replaced this server's.
async function followSelection(
  plugin: ApplePlugin,
  selection: string,
  changed: AbortController,
  updated: AbortController,
  signal: AbortSignal,
) {
  try {
    for await (const _ of setInterval(1_000, undefined, { signal }))
      try {
        if (plugin.updated()) updated.abort();
        else if (JSON.stringify(readSelections(plugin.directory)) !== selection)
          changed.abort();
      } catch {
        // Unreadable for now, such as while the disk is full: ask again.
      }
  } catch {
    // Aborted: the selection changed, the plugin was updated, or the watch ended.
  }
}

// Waits until this server may lead: the lease is free and the plugin was not
// updated. null once it was updated or the server stops.
async function acquire(
  plugin: ApplePlugin,
  signal: AbortSignal,
): Promise<Disposable | null> {
  for (;;) {
    if (plugin.updated()) return null;
    const held = lease(plugin.directory);
    if (held !== null) return held;
    try {
      await sleep(2_000, undefined, { signal });
    } catch {
      return null;
    }
  }
}

// Leads until the server stops or the plugin is updated; a new chat's server
// then leads with the new version.
async function lead(plugin: ApplePlugin, signal: AbortSignal) {
  const { directory } = plugin;
  const updated = new AbortController();
  const leading = AbortSignal.any([signal, updated.signal]);
  while (!leading.aborted) {
    const changed = new AbortController();
    const watching = AbortSignal.any([leading, changed.signal]);
    let following = Promise.resolve();
    try {
      const selections = readSelections(directory);
      following = followSelection(
        plugin,
        JSON.stringify(selections),
        changed,
        updated,
        watching,
      );
      tidy(directory);
      // A selection may name a connector added since the last pass.
      await plugin.refresh();
      await watchImports(plugin, selections, watching);
    } catch {
      // Retried below, once the selection changes or a minute passes.
    }
    await sleep(60_000, undefined, { signal: watching }).catch(() => {});
    changed.abort();
    await following;
  }
}

// While this server runs, keeps every selected app's import current. One
// server per Mac leads; the others wait to take over. A server whose plugin
// was updated stops leading for good. A changed selection, from any chat,
// restarts the watch; a watch whose sources all stopped, such as for a
// missing permission, retries after a minute. It never throws: a failure
// outside any pass, such as a full disk, is retried too, so the plugin's
// tools keep working.
export async function keepFresh(
  plugin: ApplePlugin,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const leader = await acquire(plugin, signal);
    if (leader === null) return;
    using _lease = leader;
    await lead(plugin, signal);
  }
}
