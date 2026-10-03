import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import type {
  BrokenConnector,
  Connectors,
} from '@workspace/apple-manifest/connectors';
import { userConnectors } from '@workspace/apple-manifest/user-connectors';
import type { AppleApp, AppleHost } from '@workspace/apple/apps/apple-app';
import {
  type AppFacts,
  type ImportScope,
  ImportStore,
  NewerLayoutError,
  type Pass,
  type Selection,
  leaseHeld,
} from '@workspace/import-store';

const ids = z.array(z.string().min(1).max(1024)).max(1000);

// An app by its connector's name. Connectors are rediscovered on use, so the
// name is checked when a tool runs, not by an enum fixed when the chat began.
export const appSchema = z
  .string()
  .min(1)
  .describe(
    'An Apple app the user chose, by the name the Apple status or apple_options uses.',
  );

// The shape of a selection as tools receive it; ImportStore.select checks it
// against what each app can be narrowed by.
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
    .describe(
      'The complete selection. An app left out is disconnected and its imported copy deleted.',
    ),
});

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

// Setup and status for the Codex plugin. The leading server's importSelected
// writes each app's data.sqlite; agents read those files directly.
export class ApplePlugin {
  // The installed plugin's folder. Installing another version deletes it.
  readonly install: string;
  readonly directory: string;
  readonly #connectors: Connectors;
  readonly #host: AppleHost;
  #apps: readonly AppleApp[] = [];
  #broken: readonly BrokenConnector[] = [];

  constructor(
    connectors: Connectors,
    host: AppleHost,
    install: string,
    directory = join(
      homedir(),
      'Library/Application Support/Context Compiler/Apple',
    ),
  ) {
    this.#connectors = connectors;
    this.#host = host;
    this.install = install;
    this.directory = directory;
  }

  get apps(): readonly AppleApp[] {
    return this.#apps;
  }

  // Connectors that were found but could not load, for chats to hear of.
  get broken(): readonly BrokenConnector[] {
    return this.#broken;
  }

  // Discovers the connectors again, so one added or edited since the last
  // refresh loads, and one removed is gone.
  async refresh(): Promise<void> {
    const { apps, broken } = await this.#connectors.load(this.#host);
    this.#apps = apps;
    this.#broken = broken;
  }

  app(name: string): AppleApp {
    const app = this.#loaded(name);
    if (app === undefined)
      throw new TypeError(
        `No Apple app is named ${name}. The apps are ${this.#apps.map((candidate) => candidate.name).join(', ')}.`,
      );
    return app;
  }

  #loaded(name: string): AppleApp | undefined {
    return this.#apps.find((candidate) => candidate.name === name);
  }

  // What macOS needs granted for an app, or how to bring back a selected app
  // whose connector is not loaded.
  #permissions(name: string): string {
    return (
      this.#loaded(name)?.guidance() ??
      `No connector named ${name} is loaded: fix or restore its folder in ${userConnectors}, or disconnect it.`
    );
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
          title: this.#loaded(item.app)?.title ?? item.app,
          database: existsSync(database) ? database : null,
          sync,
          permissions: this.#permissions(item.app),
        };
      }),
    };
  }

  // A changed scope is a new import: the leading server loads it, and the
  // previous one is removed, so nothing reads an import that is not selected.
  // An app whose connector is not loaded keeps only the selection it has, so
  // a connector broken while it is edited loses nothing.
  configure(requested: { readonly apps: readonly Selection[] }) {
    {
      using store = this.#open();
      const stored = store.selections();
      store.select(
        requested.apps.map((item) => {
          const app = this.#loaded(item.app);
          return app === undefined
            ? item
            : { ...item, scope: { ...app.defaultScope(), ...item.scope } };
        }),
        {
          facts: (name) =>
            this.#loaded(name) ?? unchanged(name, stored, requested.apps),
          permissions: ({ app }) => this.#permissions(app),
        },
      );
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

// What an unloaded app's selection can be narrowed by: exactly what it is
// narrowed by now, so only the selection it already has passes.
function unchanged(
  name: string,
  stored: readonly Selection[],
  requested: readonly Selection[],
): AppFacts {
  const before = stored.find(({ app }) => app === name);
  const after = requested.find(({ app }) => app === name);
  if (
    before === undefined ||
    after === undefined ||
    JSON.stringify(before) !== JSON.stringify(after)
  )
    throw new TypeError(
      `No connector named ${name} is loaded, so its selection cannot change: fix or restore it in ${userConnectors}, or disconnect it.`,
    );
  const scope: ImportScope = before.scope;
  return {
    narrowsBy: (kind) => scope[kind] !== undefined,
    // Any value but null lets the dates it already has stand.
    datedBy:
      scope.startAt === undefined && scope.endAt === undefined ? null : name,
  };
}
