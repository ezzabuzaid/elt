import { SQLitePasses, SQLiteSyncHistory } from '@workspace/elt-sqlite';
import { Settings } from '@workspace/settings';

import type { ApplePlugin } from './apple-plugin.ts';

// Loads every selected connector no pass has loaded completely: one never
// imported, one a stopped server left running, and one whose pass failed or
// loaded only in part. Until some pass loaded every copy, each pass runs the
// whole import again from its checkpoints, so rows a full disk or a busy app
// cut short still arrive; from then it stays as it is until its selection
// changes. Codex runs a server per chat, so an import another server is
// loading is skipped, and one the user removes meanwhile stops. A server whose
// plugin was updated loads nothing, so old code never writes. A connector that
// is not loaded has no pass to record its failure, so the settings keep it
// until it loads. Never throws, so a failure such as a full disk leaves the
// tools working, and the next server start or selection change tries again.
export async function importPending(plugin: ApplePlugin): Promise<void> {
  if (plugin.updated()) return;
  try {
    using settings = new Settings(plugin.directory);
    // Readers see the selection, and no import that is no longer selected.
    settings.publish();
    await settings.removeStaleImports();
    const history = new SQLiteSyncHistory();
    await Promise.allSettled(
      settings.selections().map(async (item) => {
        const { pass } = await new SQLitePasses(
          settings.database(item),
        ).status();
        if (pass !== null && pass.lastSucceededAt !== null) return;
        let connector;
        try {
          connector = plugin.connector(item.connector);
        } catch (error) {
          settings.saveConnectionFailure(
            item,
            error instanceof Error ? error.message : String(error),
          );
          return;
        }
        await connector.import(settings, item, history);
      }),
    );
  } catch {
    // Every failed pass is recorded against its connector by the history.
  }
}
