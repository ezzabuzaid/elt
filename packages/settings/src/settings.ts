import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { FailureType } from '@workspace/elt';
import {
  SQLitePasses,
  installSQLiteCatalog,
  publishSQLiteViews,
} from '@workspace/elt-sqlite';

import {
  type ConnectorFacts,
  type Selection,
  selectionProblems,
} from './selection.ts';
import {
  NewerLayoutError,
  importDirectory,
  storeLayout,
} from './store-layout.ts';

// How long a connection waits out another process writing the settings.
const writerWaitMs = 30_000;

// How often an import that is running checks that the user still selects it,
// as Airbyte's worker sends a heartbeat to learn its sync was cancelled.
const heartbeatMs = 1_000;

// Why a connector's import could not start, and whose that is to fix: its
// pipeline never existed, so its sync history in data.sqlite cannot say.
type ConnectionFailure = {
  error: string;
  failedAt: string;
  failureType: FailureType;
};

// The reason a running import stops when the user removes its connector.
export class ConnectorRemovedError extends Error {
  override name = 'ConnectorRemovedError';

  constructor(connector: string) {
    super(`${connector} was removed from the selection`);
  }
}

// What readers of the settings file see: one row per selected connector, with
// where its import lives and why it could not start, if it could not.
const selectedConnectors = {
  name: 'selected_connectors',
  description:
    'The connectors the user chose to import, in the order chosen. A connector missing here is not imported. Each import is its own SQLite file: open database to read its records, catalog and sync_status.',
  columns: {
    connector: 'Connector name, such as mail, notes or messages.',
    scope:
      'JSON of the chosen accounts (accountIds), collections (collectionIds) and dates (startAt inclusive, endAt exclusive); an absent key means all.',
    include_attachments:
      '1 when attachment bytes are copied beside the records, 0 for metadata only.',
    database:
      'Path of the SQLite file the import loads. It may not exist yet while the first import starts.',
    connection_error:
      'Why the import could not start, such as missing macOS access; NULL when it started. A connector with an error is inaccessible, not empty.',
    connection_failure_type:
      'config when the user can fix connection_error by giving access or changing what they set up, and permissions says how; system for any other reason; NULL when the import started.',
    connection_failed_at:
      'When the import last failed to start, as an ISO 8601 UTC timestamp; NULL when it started.',
    permissions: 'What the user can do in macOS to give access to this app.',
  },
  query: `SELECT s."connector", s."scope", s."include_attachments", s."directory" || '/data.sqlite' AS "database",
      f."error" AS "connection_error", f."failure_type" AS "connection_failure_type", f."failed_at" AS "connection_failed_at", s."permissions"
    FROM "selections" s LEFT JOIN "connection_failures" f ON f."directory" = s."directory"
    ORDER BY s."position"`,
};

// One host's settings under root: settings.sqlite holds the selection and each
// import's connection failure, stamped with the store layout, and readers find
// the imports through its selected_connectors view; each import lives in its
// own directory beside it.
export class Settings implements Disposable {
  readonly root: string;
  private readonly settings: DatabaseSync;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const path = this.#path;
    this.settings = new DatabaseSync(path, { timeout: writerWaitMs });
    try {
      chmodSync(path, 0o600);
      if (this.layout() !== storeLayout) this.rebuild();
      this.settings.exec(
        `CREATE TABLE IF NOT EXISTS selections (position INTEGER PRIMARY KEY, connector TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, include_attachments INTEGER NOT NULL, directory TEXT NOT NULL, permissions TEXT NOT NULL); CREATE TABLE IF NOT EXISTS connection_failures (directory TEXT PRIMARY KEY, error TEXT NOT NULL, failure_type TEXT NOT NULL CHECK (failure_type IN ('config', 'system')), failed_at TEXT NOT NULL);`,
      );
    } catch (error) {
      this.settings.close();
      throw error;
    }
  }

  get #path(): string {
    return join(this.root, 'settings.sqlite');
  }

  private layout(): number {
    return Number(
      this.settings.prepare('PRAGMA user_version').get()?.user_version,
    );
  }

  // Refuses a file a newer layout wrote, and empties one an older layout
  // wrote: stored settings are disposable, so the user sets up again.
  private rebuild() {
    this.settings.exec('BEGIN IMMEDIATE');
    try {
      const layout = this.layout();
      if (layout > storeLayout) throw new NewerLayoutError();
      if (layout < storeLayout) {
        for (const { type, name } of this.settings
          .prepare(
            "SELECT type, name FROM sqlite_schema WHERE type IN ('view', 'table') AND name NOT LIKE 'sqlite_%' ORDER BY type = 'table'",
          )
          .all())
          this.settings.exec(
            `DROP ${type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS "${String(name).replaceAll('"', '""')}"`,
          );
        this.settings.exec(`PRAGMA user_version = ${storeLayout}`);
      }
      this.settings.exec('COMMIT');
    } catch (error) {
      this.settings.exec('ROLLBACK');
      throw error;
    }
  }

  selections(): Selection[] {
    return this.settings
      .prepare(
        'SELECT connector, scope, include_attachments FROM selections ORDER BY position',
      )
      .all()
      .map((row) => ({
        connector: String(row.connector),
        scope: JSON.parse(String(row.scope)),
        includeAttachments: row.include_attachments === 1,
      }));
  }

  // Saves a selection that has no problems, with what macOS needs granted for
  // each connector, forgets the failures of every other import, removes those
  // imports and publishes what readers see.
  async select<Selected extends Selection>(
    selections: readonly Selected[],
    {
      facts,
      permissions,
    }: {
      facts: (connector: string) => ConnectorFacts;
      permissions: (selection: Selected) => string;
    },
  ): Promise<void> {
    const problems = selectionProblems(selections, facts);
    if (problems.length > 0) throw new Error(problems.join('\n'));
    this.settings.exec('BEGIN IMMEDIATE');
    try {
      this.settings.exec('DELETE FROM selections');
      const insert = this.settings.prepare(
        'INSERT INTO selections VALUES(?,?,?,?,?,?)',
      );
      for (const [position, selection] of selections.entries())
        insert.run(
          position,
          selection.connector,
          JSON.stringify(selection.scope),
          selection.includeAttachments ? 1 : 0,
          this.directory(selection),
          permissions(selection),
        );
      this.settings.exec(
        'DELETE FROM connection_failures WHERE directory NOT IN (SELECT directory FROM selections)',
      );
      this.settings.exec('COMMIT');
    } catch (error) {
      this.settings.exec('ROLLBACK');
      throw error;
    }
    await this.removeStaleImports();
    this.publish();
  }

  // Removes every import directory but the selected one of each connector,
  // including those of connectors no longer selected. One a pass still runs
  // is left to that pass, which removes it once its removal stops it.
  async removeStaleImports(): Promise<void> {
    const kept = new Set(
      this.selections().map((selection) => this.directory(selection)),
    );
    for (const connector of readdirSync(this.root, { withFileTypes: true }))
      if (connector.isDirectory())
        for (const entry of readdirSync(join(this.root, connector.name))) {
          const directory = join(this.root, connector.name, entry);
          if (
            !kept.has(directory) &&
            !(await new SQLitePasses(join(directory, 'data.sqlite')).running())
          )
            rmSync(directory, { recursive: true, force: true });
        }
  }

  // Aborts with ConnectorRemovedError once the selection no longer names this
  // import. It reads the settings again only when PRAGMA data_version says
  // another connection committed.
  removal(selection: Selection): Disposable & { readonly signal: AbortSignal } {
    const directory = this.directory(selection);
    const watcher = new DatabaseSync(this.#path, {
      readOnly: true,
      timeout: writerWaitMs,
    });
    const version = watcher.prepare('PRAGMA data_version');
    const selected = watcher.prepare(
      'SELECT 1 FROM selections WHERE directory = ?',
    );
    const controller = new AbortController();
    let seen: unknown;
    // A timer's error would end the process; the import stops with it instead.
    const check = () => {
      try {
        const current = version.get()?.data_version;
        if (current === seen) return;
        seen = current;
        if (selected.get(directory) === undefined)
          controller.abort(new ConnectorRemovedError(selection.connector));
      } catch (error) {
        controller.abort(error);
      }
    };
    check();
    const heartbeat = setInterval(check, heartbeatMs);
    const stop = () => {
      clearInterval(heartbeat);
      if (watcher.isOpen) watcher.close();
    };
    controller.signal.addEventListener('abort', stop, { once: true });
    return { signal: controller.signal, [Symbol.dispose]: stop };
  }

  // Publishes selected_connectors and the catalog listing it; safe to repeat.
  publish() {
    publishSQLiteViews(this.settings, { views: [selectedConnectors] });
    installSQLiteCatalog({ path: this.#path });
  }

  directory(selection: Selection): string {
    return importDirectory(this.root, selection);
  }

  database(selection: Selection): string {
    return join(this.directory(selection), 'data.sqlite');
  }

  connectionFailure(selection: Selection): ConnectionFailure | undefined {
    const row = this.settings
      .prepare(
        'SELECT error, failure_type, failed_at FROM connection_failures WHERE directory=?',
      )
      .get(this.directory(selection));
    return row === undefined
      ? undefined
      : {
          error: String(row.error),
          failedAt: String(row.failed_at),
          failureType: row.failure_type === 'config' ? 'config' : 'system',
        };
  }

  saveConnectionFailure(
    selection: Selection,
    error: string,
    failureType: FailureType,
  ) {
    this.settings
      .prepare(
        "INSERT INTO connection_failures (directory, error, failure_type, failed_at) VALUES(?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(directory) DO UPDATE SET error=excluded.error, failure_type=excluded.failure_type, failed_at=excluded.failed_at",
      )
      .run(this.directory(selection), error, failureType);
  }

  clearConnectionFailure(selection: Selection) {
    this.settings
      .prepare('DELETE FROM connection_failures WHERE directory=?')
      .run(this.directory(selection));
  }

  [Symbol.dispose]() {
    this.settings.close();
  }
}
