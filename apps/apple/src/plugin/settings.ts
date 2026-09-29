import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { type App, appNames, apps } from './apps.ts';

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

export type SyncResult = {
  state: 'running' | 'succeeded' | 'partial' | 'failed';
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
        'CREATE TABLE IF NOT EXISTS configuration (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sync_status (app TEXT PRIMARY KEY, value TEXT NOT NULL);',
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

  syncResult(app: App): SyncResult | undefined {
    const row = this.database
      .prepare('SELECT value FROM sync_status WHERE app=?')
      .get(app);
    return row === undefined
      ? undefined
      : (JSON.parse(String(row.value)) as SyncResult);
  }

  saveSyncResult(app: App, result: SyncResult) {
    this.database
      .prepare(
        'INSERT INTO sync_status VALUES(?,?) ON CONFLICT(app) DO UPDATE SET value=excluded.value',
      )
      .run(app, JSON.stringify(result));
  }

  // Saves the selection and forgets the sync history of the apps it changes.
  saveConfiguration(configuration: Configuration, changed: readonly App[]) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const app of changed)
        this.database.prepare('DELETE FROM sync_status WHERE app=?').run(app);
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

  [Symbol.dispose]() {
    this.database.close();
  }
}

// One setup or sync at a time per Mac, across Codex chats. The native lock
// releases when its process exits.
export function lockOperations(directory: string): Disposable {
  const database = new DatabaseSync(join(directory, 'operation.sqlite'));
  try {
    database.exec('BEGIN IMMEDIATE');
  } catch {
    database.close();
    throw new Error(
      'Apple setup or sync is already running in another Codex chat. Try again when it finishes.',
    );
  }
  return { [Symbol.dispose]: () => database.close() };
}
