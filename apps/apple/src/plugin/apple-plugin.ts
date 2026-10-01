import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CopyConfiguration, StreamStatus } from 'elt';
import { z } from 'zod';
import { type App, apps, type ChoiceRows } from './apps.ts';
import { leaderRunning } from './freshness.ts';
import {
  configurationSchema,
  importDirectory,
  removeStaleImports,
  Settings,
} from './settings.ts';

// One row of the sync_status view the import's history keeps in data.sqlite:
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
type Pass = z.infer<typeof passSchema>;

// An import's latest pass, as its status reports it. interrupted: running
// when no server is left to finish it.
export type ImportSync =
  | Pass
  | (Omit<Extract<Pass, { state: 'running' }>, 'state'> & {
      state: 'interrupted';
    });

// null until the import's history is installed and has begun a pass.
function latestPass(database: string): Pass | null {
  if (!existsSync(database)) return null;
  using data = new DatabaseSync(database, { readOnly: true, timeout: 30_000 });
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

// Setup and status for the Codex plugin. The leading server's keepFresh
// writes each app's data.sqlite; agents read those files directly.
export class ApplePlugin {
  constructor(
    readonly directory = join(
      homedir(),
      'Library/Application Support/Context Compiler/Apple',
    ),
  ) {}

  status() {
    using settings = new Settings(this.directory);
    const configuration = settings.configuration();
    const leading = leaderRunning(this.directory);
    return {
      apps: configuration.apps.map((item) => {
        const importPath = importDirectory(this.directory, item);
        const database = join(importPath, 'data.sqlite');
        const pass = latestPass(database);
        const failure = settings.connectionFailure(importPath);
        const sync: ImportSync | null =
          failure !== undefined
            ? {
                state: 'failed',
                startedAt: failure.failedAt,
                completedAt: failure.failedAt,
                lastSucceededAt: pass?.lastSucceededAt ?? null,
                error: failure.error,
              }
            : pass?.state === 'running' && !leading
              ? { ...pass, state: 'interrupted' }
              : pass;
        return {
          ...item,
          database: existsSync(database) ? database : null,
          sync,
          permissions: apps[item.app].permissions,
        };
      }),
    };
  }

  // A changed scope is a new import: the leading server loads it and removes
  // the previous one, and nothing reads an import that is not selected.
  configure(input: unknown) {
    const requested = configurationSchema.parse(input);
    const configuration = configurationSchema.parse({
      apps: requested.apps.map((item) => ({
        ...item,
        scope: { ...apps[item.app].defaultScope?.(), ...item.scope },
      })),
    });
    {
      using settings = new Settings(this.directory);
      settings.saveConfiguration(configuration);
    }
    removeStaleImports(this.directory, configuration);
    return this.status();
  }

  async options(app: App) {
    const definition = apps[app];
    const source = definition.source(definition.defaultScope?.() ?? {});
    const catalog = await source.discover();
    const choices: ChoiceRows = {};
    for await (const message of source.read(
      definition.choices.map(
        (choice) =>
          new CopyConfiguration(catalog.get(choice.stream), {
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite',
          }),
      ),
      new Map(),
    )) {
      if (message instanceof StreamStatus) {
        if (message.status === 'FAILED') throw message.error;
        continue;
      }
      // Every Apple source validates its records against the stream's object schema.
      if (!('type' in message))
        choices[message.stream] = [
          ...(choices[message.stream] ?? []),
          message.data as ChoiceRows[string][number],
        ];
    }
    return {
      app,
      choices,
      permissions: definition.permissions,
      datedBy: definition.datedBy,
      defaultScope: definition.defaultScope?.(),
      note: definition.note,
    };
  }
}
