import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CopyConfiguration, StreamStatus } from 'elt';
import {
  ImportStore,
  leaseHeld,
  NewerLayoutError,
  type Pass,
  type Selection,
} from 'import-store';
import { z } from 'zod';
import {
  type App,
  appFacts,
  appNamed,
  appNames,
  apps,
  type ChoiceRows,
} from './apps.ts';

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
            accountIds: ids
              .describe(
                'Account IDs from apple_options. Omit to import every account; never pass an empty list.',
              )
              .optional(),
            collectionIds: ids
              .describe(
                'Collection IDs (folders, calendars, lists, profiles) from apple_options. Omit to import every collection; never pass an empty list.',
              )
              .optional(),
            startAt: z.iso
              .datetime({ precision: 3 })
              .describe(
                'Inclusive UTC start with milliseconds, such as 2026-01-01T00:00:00.000Z. Only for an app whose apple_options datedBy is not null.',
              )
              .optional(),
            endAt: z.iso
              .datetime({ precision: 3 })
              .describe(
                'Exclusive UTC end with milliseconds; use the following midnight to include an end date.',
              )
              .optional(),
          })
          .default({}),
        includeAttachments: z
          .boolean()
          .describe('Copy attachments; false imports metadata only.')
          .default(true),
      }),
    )
    .max(appNames.length)
    .describe(
      'The complete selection. An app left out is disconnected and its imported copy deleted.',
    ),
});
export type AppConfiguration = Selection & { readonly app: App };

// Thrown by a server whose plugin version was replaced. Codex keeps an old
// chat's server running after an upgrade, so that chat must move on.
export class PluginUpdatedError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      'Apple was updated after this chat started. This chat runs the old version, so its Apple tools and status are out of date: open a new chat to use Apple.',
      options,
    );
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
    // The installed plugin's folder. Installing another version deletes it.
    readonly install: string,
    readonly directory = join(
      homedir(),
      'Library/Application Support/Context Compiler/Apple',
    ),
  ) {}

  // The store, refused once another plugin version replaced this one: Codex
  // deleted this version's folder, or that version rewrote the settings in a
  // layout this code predates.
  #open(): ImportStore {
    if (!existsSync(join(this.install, '.codex-plugin/plugin.json')))
      throw new PluginUpdatedError();
    try {
      return new ImportStore(this.directory);
    } catch (error) {
      if (error instanceof NewerLayoutError)
        throw new PluginUpdatedError({ cause: error });
      throw error;
    }
  }

  updated(): boolean {
    try {
      using _store = this.#open();
      return false;
    } catch (error) {
      // Any other failure, such as a full disk, says nothing about versions.
      return error instanceof PluginUpdatedError;
    }
  }

  status() {
    using store = this.#open();
    const leading = leaseHeld(this.directory);
    return {
      apps: store.selections().map((selection) => {
        const item: AppConfiguration = {
          ...selection,
          app: appNamed(selection.app),
        };
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
  configure(requested: { readonly apps: readonly AppConfiguration[] }) {
    const configuration = requested.apps.map((item) => ({
      ...item,
      scope: { ...apps[item.app].defaultScope?.(), ...item.scope },
    }));
    {
      using store = this.#open();
      store.select(configuration, {
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
