import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { installSQLiteCatalog, publishSQLiteViews } from 'elt-sqlite';
import { z } from 'zod';
import { appNames, apps } from './apps.ts';

export const appSchema = z.enum(appNames);
const ids = z
  .array(z.string().min(1).max(1024))
  .min(1)
  .max(1000)
  .refine(
    (values) => new Set(values).size === values.length,
    'Choose each item once',
  );
export const scopeSchema = z
  .strictObject({
    accountIds: ids.optional(),
    collectionIds: ids.optional(),
    startAt: z.iso.datetime({ precision: 3 }).optional(),
    endAt: z.iso.datetime({ precision: 3 }).optional(),
  })
  .refine(
    (scope) =>
      scope.startAt === undefined ||
      scope.endAt === undefined ||
      scope.startAt < scope.endAt,
    'Start must precede end',
  );
export const configurationSchema = z
  .strictObject({
    apps: z
      .array(
        z.strictObject({
          app: appSchema,
          scope: scopeSchema.default({}),
          includeAttachments: z.boolean().default(true),
        }),
      )
      .max(appNames.length),
  })
  .superRefine((configuration, context) => {
    if (
      new Set(configuration.apps.map((item) => item.app)).size !==
      configuration.apps.length
    )
      context.addIssue({ code: 'custom', message: 'Choose each app once' });
    for (const { app, scope } of configuration.apps) {
      if (!apps[app].accounts && scope.accountIds !== undefined)
        context.addIssue({
          code: 'custom',
          message: `${app}: choose collections instead of account IDs`,
        });
      if (
        apps[app].datedBy === null &&
        (scope.startAt !== undefined || scope.endAt !== undefined)
      )
        context.addIssue({
          code: 'custom',
          message: `${app}: date filtering is unavailable; choose collections`,
        });
    }
  });
export type Configuration = z.infer<typeof configurationSchema>;
export type AppConfiguration = Configuration['apps'][number];

// What the settings file and each import directory hold. Changing what is
// stored, such as a settings table or a table name a checkpoint binds to,
// takes a new layout: every app imports afresh, the settings file is rebuilt,
// and servers running older code stop writing.
const storeLayout = 2;

// Thrown by a server whose code predates the layout of the settings file.
export class NewerStoreError extends Error {
  constructor() {
    super(
      'Apple was updated on this Mac. Start a new chat to use the new version.',
    );
  }
}

// Where an app's import lives: one directory per selection and store layout,
// so a pass still writing an earlier one never touches the current one.
export function importDirectory(directory: string, item: AppConfiguration) {
  const key = createHash('sha256')
    .update(JSON.stringify([storeLayout, item.scope, item.includeAttachments]))
    .digest('hex')
    .slice(0, 16);
  return join(directory, item.app, key);
}

// Removes every import but the selected one of each app, including the imports
// of apps no longer selected.
export function removeStaleImports(
  directory: string,
  configuration: Configuration,
) {
  for (const app of appNames) {
    const item = configuration.apps.find((selected) => selected.app === app);
    const kept = item === undefined ? null : importDirectory(directory, item);
    const root = join(directory, app);
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries)
      if (join(root, entry) !== kept)
        rmSync(join(root, entry), { recursive: true, force: true });
  }
}

// Why an app's import could not start: its pipeline never existed, so its sync
// history in data.sqlite cannot say.
export type ConnectionFailure = { error: string; failedAt: string };

// What readers of the settings file see: one row per selected app, with where
// its import lives and why it could not start, if it could not.
const selectedApps = {
  name: 'selected_apps',
  description:
    'The Apple apps the user chose to import, in the order chosen. An app missing here is not imported. Each import is its own SQLite file: open database to read its records, catalog and sync_status.',
  columns: {
    app: 'Apple app: mail, notes, messages, contacts, calendar, reminders or safari.',
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
    permissions:
      'What the user can do in macOS to give the plugin access to this app.',
  },
  query: `SELECT s."app", s."scope", s."include_attachments", s."directory" || '/data.sqlite' AS "database",
      f."error" AS "connection_error", f."failed_at" AS "connection_failed_at", s."permissions"
    FROM "selections" s LEFT JOIN "connection_failures" f ON f."directory" = s."directory"
    ORDER BY s."position"`,
};

// The user's selection and each import's connection failure, in a private
// settings file that agents read through selected_apps.
export class Settings implements Disposable {
  private readonly database: DatabaseSync;

  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = join(directory, 'settings.sqlite');
    this.database = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      if (this.layout() !== storeLayout) this.rebuild();
      this.database.exec(
        'CREATE TABLE IF NOT EXISTS selections (position INTEGER PRIMARY KEY, app TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, include_attachments INTEGER NOT NULL, directory TEXT NOT NULL, permissions TEXT NOT NULL); CREATE TABLE IF NOT EXISTS connection_failures (directory TEXT PRIMARY KEY, error TEXT NOT NULL, failed_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS servers (id TEXT PRIMARY KEY, version TEXT NOT NULL, seen_at INTEGER NOT NULL);',
      );
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private layout(): number {
    return Number(
      this.database.prepare('PRAGMA user_version').get()?.user_version,
    );
  }

  // Refuses a file a newer layout wrote, and empties one an older layout
  // wrote: stored settings are disposable, so the user sets up again.
  private rebuild() {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const layout = this.layout();
      if (layout > storeLayout) throw new NewerStoreError();
      if (layout < storeLayout) {
        for (const { type, name } of this.database
          .prepare(
            "SELECT type, name FROM sqlite_schema WHERE type IN ('view', 'table') AND name NOT LIKE 'sqlite_%' ORDER BY type = 'table'",
          )
          .all())
          this.database.exec(
            `DROP ${type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS "${String(name).replaceAll('"', '""')}"`,
          );
        this.database.exec(`PRAGMA user_version = ${storeLayout}`);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  configuration(): Configuration {
    return configurationSchema.parse({
      apps: this.database
        .prepare(
          'SELECT app, scope, include_attachments FROM selections ORDER BY position',
        )
        .all()
        .map((row) => ({
          app: row.app,
          scope: JSON.parse(String(row.scope)),
          includeAttachments: row.include_attachments === 1,
        })),
    });
  }

  connectionFailure(importPath: string): ConnectionFailure | undefined {
    const row = this.database
      .prepare(
        'SELECT error, failed_at FROM connection_failures WHERE directory=?',
      )
      .get(importPath);
    return row === undefined
      ? undefined
      : { error: String(row.error), failedAt: String(row.failed_at) };
  }

  saveConnectionFailure(importPath: string, error: string) {
    this.database
      .prepare(
        "INSERT INTO connection_failures VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(directory) DO UPDATE SET error=excluded.error, failed_at=excluded.failed_at",
      )
      .run(importPath, error);
  }

  clearConnectionFailure(importPath: string) {
    this.database
      .prepare('DELETE FROM connection_failures WHERE directory=?')
      .run(importPath);
  }

  // Saves the selection, forgets the failures of every other import, and
  // publishes what readers see.
  saveConfiguration(configuration: Configuration) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec('DELETE FROM selections');
      const insert = this.database.prepare(
        'INSERT INTO selections VALUES(?,?,?,?,?,?)',
      );
      for (const [position, item] of configuration.apps.entries())
        insert.run(
          position,
          item.app,
          JSON.stringify(item.scope),
          item.includeAttachments ? 1 : 0,
          importDirectory(this.directory, item),
          apps[item.app].permissions,
        );
      this.database.exec(
        'DELETE FROM connection_failures WHERE directory NOT IN (SELECT directory FROM selections)',
      );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    this.publish();
  }

  // Publishes selected_apps and the catalog that lists it; safe to repeat.
  publish() {
    publishSQLiteViews(this.database, { views: [selectedApps] });
    installSQLiteCatalog({ path: join(this.directory, 'settings.sqlite') });
  }

  // Each running plugin server's version, seen within the last heartbeats;
  // servers gone for an hour are forgotten.
  heartbeat(id: string, version: string, now: number) {
    this.database
      .prepare(
        'INSERT INTO servers VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, seen_at=excluded.seen_at',
      )
      .run(id, version, now);
    this.database
      .prepare('DELETE FROM servers WHERE seen_at < ?')
      .run(now - 3_600_000);
  }

  runningVersions(since: number): string[] {
    return this.database
      .prepare('SELECT version FROM servers WHERE seen_at >= ?')
      .all(since)
      .map((row) => String(row.version));
  }

  forgetServer(id: string) {
    this.database.prepare('DELETE FROM servers WHERE id=?').run(id);
  }

  [Symbol.dispose]() {
    this.database.close();
  }
}
