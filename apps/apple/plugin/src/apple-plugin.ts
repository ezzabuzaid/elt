import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import type {
  AppleConnector,
  AppleHost,
} from '@workspace/connector-apple-connector/apple-connector';
import type {
  BrokenConnector,
  Connectors,
} from '@workspace/connector-apple-manifest/connectors';
import { userConnectors } from '@workspace/connector-apple-manifest/user-connectors';
import { type PassStatus, SQLitePasses } from '@workspace/elt-sqlite';
import {
  type ConnectorFacts,
  NewerLayoutError,
  type Selection,
  Settings,
} from '@workspace/settings';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import { appleDirectory } from './apple-directory.ts';

const ids = z.array(z.string().min(1).max(1024)).max(1000);

// A connector by its name. Connectors are rediscovered on use, so the name
// is checked when a tool runs, not by an enum fixed when the chat began.
export const connectorSchema = z
  .string()
  .min(1)
  .describe(
    'A connector the user chose, by the name the Apple status or apple_options uses.',
  );

// The shape of a selection as tools receive it; Settings.select checks it
// against what each connector can be narrowed by.
export const configurationSchema = z.strictObject({
  connectors: z
    .array(
      z.strictObject({
        connector: connectorSchema,
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
                'Inclusive UTC start with milliseconds, such as 2026-01-01T00:00:00.000Z. Only for a connector whose apple_options datedBy is not null.',
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
      'The complete selection. A connector left out is disconnected and its imported copy deleted.',
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

// Setup and status for the Codex plugin. importPending writes each
// connector's data.sqlite; agents read those files directly.
export class ApplePlugin {
  // The installed plugin's folder. Installing another version deletes it.
  readonly install: string;
  readonly directory: string;
  readonly #discovery: Connectors;
  readonly #host: AppleHost;
  #connectors: readonly AppleConnector[] = [];
  #broken: readonly BrokenConnector[] = [];

  constructor(
    discovery: Connectors,
    host: AppleHost,
    install: string,
    directory = appleDirectory(),
  ) {
    this.#discovery = discovery;
    this.#host = host;
    this.install = install;
    this.directory = directory;
  }

  get connectors(): readonly AppleConnector[] {
    return this.#connectors;
  }

  // Connectors that were found but could not load, for chats to hear of.
  get broken(): readonly BrokenConnector[] {
    return this.#broken;
  }

  // Discovers the connectors again, so one added or edited since the last
  // refresh loads, and one removed is gone.
  async refresh(): Promise<void> {
    const { connectors, broken } = await this.#discovery.load(this.#host);
    this.#connectors = connectors;
    this.#broken = broken;
  }

  connector(name: string): AppleConnector {
    const connector = this.#loaded(name);
    if (connector === undefined)
      throw new TypeError(
        `No connector is named ${name}. The connectors are ${this.#connectors.map((candidate) => candidate.name).join(', ')}.`,
      );
    return connector;
  }

  #loaded(name: string): AppleConnector | undefined {
    return this.#connectors.find((candidate) => candidate.name === name);
  }

  // What macOS needs granted for a connector, or how to bring back a selected
  // connector that is not loaded.
  #permissions(name: string): string {
    return (
      this.#loaded(name)?.guidance() ??
      `No connector named ${name} is loaded: fix or restore its folder in ${userConnectors}, or disconnect it.`
    );
  }

  // The store, refused once another plugin version replaced this one: Codex
  // deleted this version's folder, or that version rewrote the settings in a
  // layout this code predates.
  #open(): Settings {
    if (!existsSync(join(this.install, '.codex-plugin/plugin.json')))
      throw new PluginUpdatedError();
    try {
      return new Settings(this.directory);
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

  async status() {
    using settings = this.#open();
    return {
      connectors: await Promise.all(
        settings.selections().map(async (item) => {
          const database = settings.database(item);
          const { pass } = await new SQLitePasses(database).status();
          const failure = settings.connectionFailure(item);
          const sync: PassStatus | null =
            failure === undefined
              ? pass
              : {
                  state: 'failed',
                  startedAt: failure.failedAt,
                  completedAt: failure.failedAt,
                  lastSucceededAt: pass?.lastSucceededAt ?? null,
                  error: failure.error,
                  failureType: failure.failureType,
                };
          return {
            ...item,
            title: this.#loaded(item.connector)?.title ?? item.connector,
            database: existsSync(database) ? database : null,
            sync,
            permissions: this.#permissions(item.connector),
          };
        }),
      ),
    };
  }

  // A changed scope is a new import: importPending loads it, and the
  // previous one is removed, so nothing reads an import that is not selected.
  // A selected connector that is not loaded keeps only the selection it has,
  // so a connector broken while it is edited loses nothing.
  async configure(requested: { readonly connectors: readonly Selection[] }) {
    {
      using settings = this.#open();
      const stored = settings.selections();
      await settings.select(
        requested.connectors.map((item) => {
          const connector = this.#loaded(item.connector);
          return connector === undefined
            ? item
            : {
                ...item,
                scope: { ...connector.defaultScope(), ...item.scope },
              };
        }),
        {
          facts: (name) =>
            this.#loaded(name) ?? unchanged(name, stored, requested.connectors),
          permissions: ({ connector }) => this.#permissions(connector),
        },
      );
    }
    return this.status();
  }

  async options(name: string) {
    const connector = this.connector(name);
    const defaultScope = connector.defaultScope();
    return {
      connector: name,
      choices: Object.fromEntries(await connector.choiceRows()),
      permissions: connector.guidance(),
      datedBy: connector.datedBy,
      defaultScope:
        Object.keys(defaultScope).length > 0 ? defaultScope : undefined,
      note: connector.note,
    };
  }
}

// What an unloaded connector's selection can be narrowed by: exactly what it
// is narrowed by now, so only the selection it already has passes.
function unchanged(
  name: string,
  stored: readonly Selection[],
  requested: readonly Selection[],
): ConnectorFacts {
  const before = stored.find(({ connector }) => connector === name);
  const after = requested.find(({ connector }) => connector === name);
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
