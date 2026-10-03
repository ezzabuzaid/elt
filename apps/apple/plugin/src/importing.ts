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

// Whether the import's first pass ended: it loaded, at least in part, so it
// stays as it is until its selection changes.
function imported(directory: string, selection: Selection): boolean {
  using store = new ImportStore(directory);
  const pass = store.latestPass(selection);
  return (
    pass !== null &&
    (pass.state === 'succeeded' ||
      pass.state === 'partial' ||
      pass.lastSucceededAt !== null)
  );
}

// Loads once every selected app whose first pass has not ended, including
// one a stopped server left running or that failed. Each pass is recorded in
// its app's data.sqlite, beside the catalog readers query; an app whose
// connection cannot be built has no pipeline to record it, so its failure is
// kept in the store's settings until it builds.
async function importPending(
  plugin: ApplePlugin,
  selections: readonly Selection[],
) {
  const { directory } = plugin;
  const imports = [];
  for (const item of selections)
    if (!imported(directory, item))
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
  await pipeline.run().catch(() => {
    // Every failure is recorded against its app by the history.
  });
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
    // Aborted: the selection changed, the plugin was updated, or the wait ended.
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
    const waiting = AbortSignal.any([leading, changed.signal]);
    let following = Promise.resolve();
    try {
      const selections = readSelections(directory);
      following = followSelection(
        plugin,
        JSON.stringify(selections),
        changed,
        updated,
        waiting,
      );
      tidy(directory);
      // A selection may name a connector added since the last pass.
      await plugin.refresh();
      await importPending(plugin, selections);
    } catch {
      // Retried below, once the selection changes or a minute passes.
    }
    await sleep(60_000, undefined, { signal: waiting }).catch(() => {});
    changed.abort();
    await following;
  }
}

// While this server runs, imports every selected app once; an import is not
// refreshed after its first pass ends. One server per Mac leads; the others
// wait to take over. A server whose plugin was updated stops leading for
// good. A changed selection, from any chat, imports what it added; an import
// whose first pass did not end, such as for a missing permission, is retried
// after a minute. It never throws: a failure outside any pass, such as a full
// disk, is retried too, so the plugin's tools keep working.
export async function importSelected(
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
