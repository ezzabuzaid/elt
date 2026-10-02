import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CopyConfiguration, StreamStatus } from 'elt';
import {
  ImportStore,
  leaseHeld,
  NewerLayoutError,
  type Pass,
} from 'import-store';
import { z } from 'zod';
import { type App, appFacts, appNames, apps, type ChoiceRows } from './apps.ts';

// The shape of a selection as tools receive it; ImportStore.select checks it
// against what each app can be narrowed by.
export const appSchema = z.enum(appNames);
const ids = z.array(z.string().min(1).max(1024)).max(1000);
export const configurationSchema = z.strictObject({
  apps: z
    .array(
      z.strictObject({
        app: appSchema,
        scope: z
          .strictObject({
            accountIds: ids.optional(),
            collectionIds: ids.optional(),
            startAt: z.iso.datetime({ precision: 3 }).optional(),
            endAt: z.iso.datetime({ precision: 3 }).optional(),
          })
          .default({}),
        includeAttachments: z.boolean().default(true),
      }),
    )
    .max(appNames.length),
});
export type Configuration = z.infer<typeof configurationSchema>;
export type AppConfiguration = Configuration['apps'][number];

// The plugin's store, refusing in the plugin's words when a newer plugin
// version owns it.
export function openStore(directory: string): ImportStore {
  try {
    return new ImportStore(directory);
  } catch (error) {
    if (error instanceof NewerLayoutError)
      throw new Error(
        'Apple was updated on this Mac. Start a new chat to use the new version.',
        { cause: error },
      );
    throw error;
  }
}

// An import's latest pass, as its status reports it. interrupted: running
// when no server is left to finish it.
export type ImportSync =
  | Pass
  | (Omit<Extract<Pass, { state: 'running' }>, 'state'> & {
      state: 'interrupted';
    });

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
    using store = openStore(this.directory);
    const configuration = configurationSchema.parse({
      apps: store.selections(),
    });
    const leading = leaseHeld(this.directory);
    return {
      apps: configuration.apps.map((item) => {
        const database = store.database(item);
        const pass = store.latestPass(item);
        const failure = store.connectionFailure(item);
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

  // A changed scope is a new import: the leading server loads it, and the
  // previous one is removed, so nothing reads an import that is not selected.
  configure(input: unknown) {
    const requested = configurationSchema.parse(input);
    const configuration = configurationSchema.parse({
      apps: requested.apps.map((item) => ({
        ...item,
        scope: { ...apps[item.app].defaultScope?.(), ...item.scope },
      })),
    });
    {
      using store = openStore(this.directory);
      store.select(configuration.apps, {
        facts: appFacts,
        permissions: ({ app }) => apps[app].permissions,
      });
    }
    return this.status();
  }

  async options(app: App) {
    const definition = apps[app];
    const source = definition.source(definition.defaultScope?.() ?? {});
    const catalog = await source.discover();
    const choices: ChoiceRows = {};
    const streams =
      definition.probe === undefined
        ? definition.choices.map(({ stream }) => stream)
        : [definition.probe];
    for await (const message of source.read(
      streams.map(
        (stream) =>
          new CopyConfiguration(catalog.get(stream), {
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
      if (!('type' in message) && message.stream !== definition.probe)
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
