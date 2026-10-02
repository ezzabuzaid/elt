import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppleApp } from 'apple/apps/apple-app';
import {
  ImportStore,
  leaseHeld,
  NewerLayoutError,
  type Pass,
  type Selection,
} from 'import-store';
import { z } from 'zod';

const ids = z.array(z.string().min(1).max(1024)).max(1000);

// The shape of a selection as tools receive it; ImportStore.select checks it
// against what each app can be narrowed by.
function configurationSchema(appSchema: z.ZodType<string>, apps: number) {
  return z.strictObject({
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
      .max(apps)
      .describe(
        'The complete selection. An app left out is disconnected and its imported copy deleted.',
      ),
  });
}

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
  readonly appSchema: z.ZodEnum<Record<string, string>>;
  readonly configurationSchema: ReturnType<typeof configurationSchema>;

  constructor(
    readonly apps: readonly AppleApp[],
    // The installed plugin's folder. Installing another version deletes it.
    readonly install: string,
    readonly directory = join(
      homedir(),
      'Library/Application Support/Context Compiler/Apple',
    ),
  ) {
    this.appSchema = z.enum(apps.map(({ name }) => name));
    this.configurationSchema = configurationSchema(this.appSchema, apps.length);
  }

  app(name: string): AppleApp {
    const app = this.apps.find((candidate) => candidate.name === name);
    if (app === undefined) throw new TypeError(`Unknown Apple app ${name}`);
    return app;
  }

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
      apps: store.selections().map((item) => {
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
          permissions: this.app(item.app).guidance(),
        };
      }),
    };
  }

  // A changed scope is a new import: the leading server loads it, and the
  // previous one is removed, so nothing reads an import that is not selected.
  configure(requested: { readonly apps: readonly Selection[] }) {
    const configuration = requested.apps.map((item) => ({
      ...item,
      scope: { ...this.app(item.app).defaultScope(), ...item.scope },
    }));
    {
      using store = this.#open();
      store.select(configuration, {
        facts: (name) => this.app(name),
        permissions: ({ app }) => this.app(app).guidance(),
      });
    }
    return this.status();
  }

  async options(name: string) {
    const app = this.app(name);
    const defaultScope = app.defaultScope();
    return {
      app: name,
      choices: Object.fromEntries(await app.choiceRows()),
      permissions: app.guidance(),
      datedBy: app.datedBy,
      defaultScope:
        Object.keys(defaultScope).length > 0 ? defaultScope : undefined,
      note: app.note,
    };
  }
}
