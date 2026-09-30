import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

// Where an app's import lives: one directory per selection, so a pass still
// writing an earlier selection never touches the current one.
export function importDirectory(directory: string, item: AppConfiguration) {
  const key = createHash('sha256')
    .update(JSON.stringify([item.scope, item.includeAttachments]))
    .digest('hex')
    .slice(0, 16);
  return join(directory, item.app, key);
}

// Removes every import but the selected one of each app, including the imports
// of apps no longer selected.
export function removeStaleImports(
  directory: string,
  configuration: Configuration | null,
) {
  for (const app of appNames) {
    const item = configuration?.apps.find((selected) => selected.app === app);
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

export type SyncResult = {
  // interrupted: running when no server was left to finish it.
  state: 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  lastSucceededAt?: string;
  error?: string;
  streams?: unknown[];
};

// The user's selection and each app's last sync, in a private settings file.
export class Settings implements Disposable {
  private readonly database: DatabaseSync;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = join(directory, 'settings.sqlite');
    this.database = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.database.exec(
        'CREATE TABLE IF NOT EXISTS configuration (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS import_status (import TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS servers (id TEXT PRIMARY KEY, version TEXT NOT NULL, seen_at INTEGER NOT NULL);',
      );
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  configuration(): Configuration | null {
    const row = this.database
      .prepare('SELECT value FROM configuration WHERE id=1')
      .get();
    return row === undefined
      ? null
      : configurationSchema.parse(JSON.parse(String(row.value)));
  }

  // The last pass of the import in one import directory.
  syncResult(importPath: string): SyncResult | undefined {
    const row = this.database
      .prepare('SELECT value FROM import_status WHERE import=?')
      .get(importPath);
    return row === undefined
      ? undefined
      : (JSON.parse(String(row.value)) as SyncResult);
  }

  saveSyncResult(importPath: string, result: SyncResult) {
    this.database
      .prepare(
        'INSERT INTO import_status VALUES(?,?) ON CONFLICT(import) DO UPDATE SET value=excluded.value',
      )
      .run(importPath, JSON.stringify(result));
  }

  // Saves the selection and forgets the status of every other import.
  saveConfiguration(configuration: Configuration, imports: readonly string[]) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          'DELETE FROM import_status WHERE import NOT IN (SELECT value FROM json_each(?))',
        )
        .run(JSON.stringify(imports));
      this.database
        .prepare(
          'INSERT INTO configuration VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
        )
        .run(JSON.stringify(configuration));
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
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
