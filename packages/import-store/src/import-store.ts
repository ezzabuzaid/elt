import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { installSQLiteCatalog, publishSQLiteViews } from 'elt-sqlite';
import { z } from 'zod';
import {
  type AppFacts,
  type Selection,
  selectionProblems,
} from './selection.ts';
import {
  importDirectory,
  NewerLayoutError,
  storeLayout,
} from './store-layout.ts';

// Why an app's import could not start: its pipeline never existed, so its sync
// history in data.sqlite cannot say.
export type ConnectionFailure = { error: string; failedAt: string };

// One row of the sync_status view an import's history keeps in data.sqlite:
// only a running pass lacks completed_at, and only an incomplete one has an
// error.
const passFields = {
  started_at: z.string(),
  last_successful_sync_at: z.string().nullable(),
};
const pass = <
  Row extends {
    status: string;
    started_at: string;
    completed_at: string | null;
    last_successful_sync_at: string | null;
    error: string | null;
  },
>(
  row: Row,
) => ({
  state: row.status as Row['status'],
  startedAt: row.started_at,
  completedAt: row.completed_at as Row['completed_at'],
  lastSucceededAt: row.last_successful_sync_at,
  error: row.error as Row['error'],
});
const passSchema = z.union([
  z
    .object({
      ...passFields,
      status: z.literal('running'),
      completed_at: z.null(),
      error: z.null(),
    })
    .transform(pass),
  z
    .object({
      ...passFields,
      status: z.literal('succeeded'),
      completed_at: z.string(),
      error: z.null(),
    })
    .transform(pass),
  z
    .object({
      ...passFields,
      status: z.enum(['partial', 'failed']),
      completed_at: z.string(),
      error: z.string(),
    })
    .transform(pass),
]);
export type Pass = z.infer<typeof passSchema>;

// What readers of the settings file see: one row per selected app, with where
// its import lives and why it could not start, if it could not.
const selectedApps = {
  name: 'selected_apps',
  description:
    'The Apple apps the user chose to import, in the order chosen. An app missing here is not imported. Each import is its own SQLite file: open database to read its records, catalog and sync_status.',
  columns: {
    app: 'Apple app, such as mail, notes or messages.',
    scope:
      'JSON of the chosen accounts (accountIds), collections (collectionIds) and dates (startAt inclusive, endAt exclusive); an absent key means all.',
    include_attachments:
      '1 when attachment bytes are copied beside the records, 0 for metadata only.',
    database:
      'Path of the SQLite file the import loads. It may not exist yet while the first import starts.',
    connection_error:
      'Why the import could not start, such as missing macOS access; NULL when it started. An app with an error is inaccessible, not empty.',
    connection_failed_at:
      'When the import last failed to start, as an ISO 8601 UTC timestamp; NULL when it started.',
    permissions: 'What the user can do in macOS to give access to this app.',
  },
  query: `SELECT s."app", s."scope", s."include_attachments", s."directory" || '/data.sqlite' AS "database",
      f."error" AS "connection_error", f."failed_at" AS "connection_failed_at", s."permissions"
    FROM "selections" s LEFT JOIN "connection_failures" f ON f."directory" = s."directory"
    ORDER BY s."position"`,
};

// One host's imports under root: settings.sqlite holds the selection and each
// import's connection failure, stamped with the store layout, and readers find
// the imports through its selected_apps view; each import lives in its own
// directory beside it.
export class ImportStore implements Disposable {
  private readonly settings: DatabaseSync;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const path = join(root, 'settings.sqlite');
    this.settings = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      if (this.layout() !== storeLayout) this.rebuild();
      this.settings.exec(
        'CREATE TABLE IF NOT EXISTS selections (position INTEGER PRIMARY KEY, app TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, include_attachments INTEGER NOT NULL, directory TEXT NOT NULL, permissions TEXT NOT NULL); CREATE TABLE IF NOT EXISTS connection_failures (directory TEXT PRIMARY KEY, error TEXT NOT NULL, failed_at TEXT NOT NULL);',
      );
    } catch (error) {
      this.settings.close();
      throw error;
    }
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
        'SELECT app, scope, include_attachments FROM selections ORDER BY position',
      )
      .all()
      .map((row) => ({
        app: String(row.app),
        scope: JSON.parse(String(row.scope)),
        includeAttachments: row.include_attachments === 1,
      }));
  }

  // Saves a selection that has no problems, with what macOS needs granted for
  // each app, forgets the failures of every other import, removes those
  // imports and publishes what readers see.
  select<Selected extends Selection>(
    selections: readonly Selected[],
    {
      facts,
      permissions,
    }: {
      facts: (app: string) => AppFacts;
      permissions: (selection: Selected) => string;
    },
  ) {
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
          selection.app,
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
    this.removeStaleImports();
    this.publish();
  }

  // Removes every import directory but the selected one of each app,
  // including those of apps no longer selected.
  removeStaleImports() {
    const kept = new Set(
      this.selections().map((selection) => this.directory(selection)),
    );
    for (const app of readdirSync(this.root, { withFileTypes: true }))
      if (app.isDirectory())
        for (const entry of readdirSync(join(this.root, app.name)))
          if (!kept.has(join(this.root, app.name, entry)))
            rmSync(join(this.root, app.name, entry), {
              recursive: true,
              force: true,
            });
  }

  // Publishes selected_apps and the catalog that lists it; safe to repeat.
  publish() {
    publishSQLiteViews(this.settings, { views: [selectedApps] });
    installSQLiteCatalog({ path: join(this.root, 'settings.sqlite') });
  }

  directory(selection: Selection): string {
    return importDirectory(this.root, selection);
  }

  database(selection: Selection): string {
    return join(this.directory(selection), 'data.sqlite');
  }

  // Opens an import's data.sqlite for reading only, waiting while a pass
  // commits. A pass stopped mid-commit leaves a hot journal that only a
  // writable connection rolls back, and until then every read-only open fails,
  // so one writable read recovers it first.
  read(selection: Selection): DatabaseSync {
    this.recover(selection);
    return new DatabaseSync(this.database(selection), {
      readOnly: true,
      timeout: 30_000,
    });
  }

  // Rolls back a hot journal a stopped pass left in an import, so readers that
  // cannot write, such as a sandboxed sqlite3 -readonly, can open it. An
  // import with no file yet has nothing to recover.
  recover(selection: Selection) {
    if (!existsSync(this.database(selection))) return;
    using recovery = new DatabaseSync(this.database(selection), {
      timeout: 30_000,
    });
    recovery.prepare('SELECT count(*) FROM sqlite_schema').get();
  }

  // The import's latest pass; null until its history is installed and has
  // begun one.
  latestPass(selection: Selection): Pass | null {
    if (!existsSync(this.database(selection))) return null;
    using data = this.read(selection);
    const installed = data
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'view' AND name = 'sync_status'",
      )
      .get();
    if (installed === undefined) return null;
    const row = data
      .prepare(
        'SELECT status, started_at, completed_at, error, last_successful_sync_at FROM sync_status',
      )
      .get();
    return row === undefined ? null : passSchema.parse(row);
  }

  connectionFailure(selection: Selection): ConnectionFailure | undefined {
    const row = this.settings
      .prepare(
        'SELECT error, failed_at FROM connection_failures WHERE directory=?',
      )
      .get(this.directory(selection));
    return row === undefined
      ? undefined
      : { error: String(row.error), failedAt: String(row.failed_at) };
  }

  saveConnectionFailure(selection: Selection, error: string) {
    this.settings
      .prepare(
        "INSERT INTO connection_failures VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(directory) DO UPDATE SET error=excluded.error, failed_at=excluded.failed_at",
      )
      .run(this.directory(selection), error);
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
