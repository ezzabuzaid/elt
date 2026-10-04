import { Pipeline } from '@workspace/elt';
import { SQLiteSyncHistory, installSQLiteCatalog } from '@workspace/elt-sqlite';
import { ImportStore, type Selection, lease } from '@workspace/import-store';

import type { ApplePlugin } from './apple-plugin.ts';

// Whether the import's first pass ended: it loaded, at least in part, so it
// stays as it is until its selection changes.
function imported(store: ImportStore, selection: Selection): boolean {
  const pass = store.latestPass(selection);
  return (
    pass !== null &&
    (pass.state === 'succeeded' ||
      pass.state === 'partial' ||
      pass.lastSucceededAt !== null)
  );
}

// Loads once every selected app whose first pass has not ended, including
// one a stopped server left running or that failed. Codex runs a server per
// chat, so each import is locked for its pass, and one another server is
// loading is skipped. A server whose plugin was updated loads nothing, so old
// code never writes. Each pass is recorded in its app's data.sqlite, beside
// the catalog readers query; an app whose connection cannot be built has no
// pipeline to record it, so its failure is kept in the store's settings until
// it builds. Never throws, so a failure such as a full disk leaves the tools
// working, and the next server start or selection change tries again.
export async function importPending(plugin: ApplePlugin): Promise<void> {
  if (plugin.updated()) return;
  try {
    using locks = new DisposableStack();
    using store = new ImportStore(plugin.directory);
    // Readers see the selection, and no import that is no longer selected.
    store.publish();
    store.removeStaleImports();
    const imports = [];
    for (const item of store.selections()) {
      if (imported(store, item)) continue;
      const directory = store.directory(item);
      const held = lease(directory);
      if (held === null) continue;
      locks.use(held);
      // Rolls back what a stopped pass left mid-commit, so readers that cannot
      // write can open the import.
      store.recover(item);
      try {
        imports.push(await plugin.app(item.app).connection(directory, item));
        store.clearConnectionFailure(item);
      } catch (error) {
        store.saveConnectionFailure(
          item,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (imports.length === 0) return;
    const history = new SQLiteSyncHistory();
    const destinations = imports.map(({ destination }) => destination);
    await history.install(destinations);
    for (const destination of destinations) installSQLiteCatalog(destination);
    await new Pipeline({
      connections: imports.map(({ connection }) => connection),
      history,
    }).run();
  } catch {
    // Every failed pass is recorded against its app by the history.
  }
}
