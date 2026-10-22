import { existsSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { SqliteElection } from '@zukhruf/election';
import { SingleFlight } from '@zukhruf/single-flight';
import type { Locate } from '@zukhruf/sqlite-federation';
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
import { type PassStatus, readPassStatus } from '@workspace/elt-sqlite';
import {
  type ConnectorFacts,
  type Selection,
  Settings,
} from '@workspace/settings';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import type { Monitors } from './monitors.ts';

const ids = z.array(z.string().min(1).max(1024)).max(1000);

// How soon a server hears that the user switched a connector to keep current
// or back, and how soon one whose plugin was updated stops its watches.
const followMs = 1_000;

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
  constructor() {
    super(
      'Apple was updated after this chat started. This chat runs the old version, so its Apple tools and status are out of date: open a new chat to use Apple.',
    );
  }
}

// Setup, imports and status for the Codex plugin. Each import writes its
// connector's data.sqlite; agents read those files directly.
export class ApplePlugin {
  // The installed plugin's folder. Installing another version deletes it.
  readonly install: string;
  readonly directory: string;
  readonly #discovery: Connectors;
  readonly #host: AppleHost;
  // The monitors each import is checked against.
  readonly monitors: Monitors;
  #connectors: readonly AppleConnector[] = [];
  #broken: readonly BrokenConnector[] = [];

  constructor(
    discovery: Connectors,
    host: AppleHost,
    install: string,
    directory: string,
    monitors: Monitors,
  ) {
    this.#discovery = discovery;
    this.#host = host;
    this.install = install;
    this.directory = directory;
    this.monitors = monitors;
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

  // Whether another plugin version replaced this one, which deletes this
  // version's folder.
  get #replaced(): boolean {
    return !existsSync(join(this.install, '.codex-plugin/plugin.json'));
  }

  // The store, refused once another plugin version replaced this one.
  #open(): Settings {
    if (this.#replaced) throw new PluginUpdatedError();
    return new Settings(this.directory);
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
    using settings = this.#open();
    const watched = settings.watched();
    return {
      connectors: settings.selections().map((item) => {
        const database = settings.database(item);
        const { pass } = readPassStatus(database);
        const failure = settings.connectionFailure(item);
        const sync: PassStatus | null =
          failure === undefined
            ? pass
            : {
                state: 'failed',
                startedAt: failure.failedAt,
                completedAt: failure.failedAt,
                lastSucceededAt: pass?.lastSucceededAt ?? null,
                currentAsOf: pass?.currentAsOf ?? null,
                error: failure.error,
                failureType: failure.failureType,
              };
        return {
          ...item,
          title: this.#loaded(item.connector)?.title ?? item.connector,
          watched: watched.includes(item.connector),
          database: existsSync(database) ? database : null,
          sync,
          content: existsSync(database)
            ? (this.#loaded(item.connector)?.contentStatus(database) ?? [])
            : [],
          permissions: this.#permissions(item.connector),
        };
      }),
    };
  }

  // Where every server of these imports meets the others: a pass of an
  // import runs in one of them at a time, and the rest wait for it.
  flights(): SingleFlight<void> {
    return new SingleFlight({
      directory: this.directory,
      codec: { encode: () => '', decode: () => undefined },
    });
  }

  // Removes each import the selection no longer names, unless a server runs
  // its pass now or keeps it current: joining that pass's flight gives up the
  // wait at once, and that pass removes its import when it ends, as a watch
  // does once it hears of the removal within a second. While a removal runs,
  // a pass of the import waits. The CLI's Imports removes stale imports the
  // same way.
  async #removeStale(
    settings: Settings,
    flights: SingleFlight<void>,
  ): Promise<void> {
    for (const directory of settings.staleImports()) {
      const joined = new AbortController();
      await flights
        .run(
          directory,
          async () => {
            await using owner = await owners(settings, directory).campaign();
            if (owner !== undefined)
              rmSync(directory, { recursive: true, force: true });
          },
          { onJoin: () => joined.abort(), signal: joined.signal },
        )
        .catch((error: unknown) => {
          if (!joined.signal.aborted) throw error;
        });
    }
  }

  // Saves the requested selection and returns the imports it creates: one for
  // each connector added and for each whose scope changed, since a changed
  // scope is a new import. The previous import is removed, so nothing reads
  // an import that is not selected. A selected connector that is not loaded
  // keeps only the selection it has, so a connector broken while it is edited
  // loses nothing.
  async configure(requested: {
    readonly connectors: readonly Selection[];
  }): Promise<Selection[]> {
    using settings = this.#open();
    const stored = settings.selections();
    const imported = new Set(stored.map((item) => settings.directory(item)));
    settings.select(requested.connectors, {
      facts: (name) =>
        this.#loaded(name) ?? unchanged(name, stored, requested.connectors),
      permissions: ({ connector }) => this.#permissions(connector),
    });
    await using flights = this.flights();
    await this.#removeStale(settings, flights);
    return settings
      .selections()
      .filter((item) => !imported.has(settings.directory(item)));
  }

  // Runs one pass of each selection's import at once, each in the import's
  // flight, so a server that finds another loading an import waits for that
  // pass instead of loading it again. An import a watch keeps current runs no
  // pass, since the watch loads each change already. A pass whose selection
  // the user removed meanwhile removes its import when it ends, since the
  // removal could not while the pass ran. A pass whose flight lost its lease
  // stops, since its outcome reaches no other server; its checkpoints resume
  // the next pass. Settles whatever the passes do: each pass records how it
  // ended in its import's sync history.
  async import(
    selections: readonly Selection[],
    options?: { afterCurrent: boolean },
  ): Promise<void> {
    await Promise.allSettled(
      selections.map(async (selection) => {
        using settings = this.#open();
        await using flights = this.flights();
        const directory = settings.directory(selection);
        let joined = false;
        const run = () =>
          flights.run(
            directory,
            async ({ signal }) => {
              await using owner = await owners(settings, directory).campaign();
              if (owner === undefined) return;
              try {
                await this.connector(selection.connector).import(
                  settings,
                  selection,
                  undefined,
                  signal,
                );
              } finally {
                if (settings.staleImports().includes(directory))
                  rmSync(directory, { recursive: true, force: true });
              }
            },
            {
              onJoin: () => {
                joined = true;
              },
            },
          );
        await run();
        // A changed parser must get its own pass after an older pass finishes.
        if (options?.afterCurrent === true && joined) await run();
      }),
    );
    // Like each pass, the check settles: a monitor's failure, settings it
    // cannot read included, is recorded on the monitor. Only a check that
    // cannot open monitors.sqlite has nowhere to say so; it runs again at the
    // next import.
    await this.#check().catch(() => undefined);
  }

  // One check at a time across the servers: one that imports while another
  // checks joins that check, so both read the keys it saved and a match is
  // sent once. What its own import brought is checked at the next import.
  async #check(): Promise<void> {
    await using flights = this.flights();
    await flights.run('monitors', () =>
      this.monitors.check(() => this.#locate()),
    );
  }

  // Switches a connector to be kept current, or back to Sync only; every
  // server hears of it within a second.
  setWatched(connector: string, watched: boolean): void {
    using settings = this.#open();
    if (watched) settings.watch(connector);
    else settings.unwatch(connector);
  }

  // Keeps each import the user chose to keep current until signal aborts.
  // Every server stands by for each, and the one that owns an import watches
  // it, so it stays current while any chat's server or the Apple page's
  // runs. Each second it follows the settings: a connector switched off,
  // narrowed or disconnected stops its watch, and one switched on or
  // narrowed starts one. A server whose plugin was updated stops its
  // watches, so a server of the new version owns them. Settles whatever the
  // watches do: each pass records how it ended in its import's sync history.
  async watch(signal: AbortSignal): Promise<void> {
    const watches = new Map<string, AbortController>();
    const running = new Set<Promise<void>>();
    try {
      using settings = this.#open();
      while (!this.#replaced) {
        const kept = keptCurrent(settings);
        for (const [directory, watch] of watches)
          if (!kept.has(directory)) {
            watch.abort();
            watches.delete(directory);
          }
        for (const [directory, selection] of kept)
          if (!watches.has(directory)) {
            const watch = new AbortController();
            watches.set(directory, watch);
            const ended = this.#keepCurrent(
              selection,
              AbortSignal.any([signal, watch.signal]),
            ).catch(() => undefined);
            running.add(ended);
            void ended.then(() => running.delete(ended));
          }
        await sleep(followMs, undefined, { signal });
      }
    } catch {
      // Stopped, or the settings could not be read: a server that starts
      // next follows them again.
    } finally {
      for (const watch of watches.values()) watch.abort();
      await Promise.all(running);
    }
  }

  // Owns the import once no other server does, then watches it until signal
  // aborts or the watch ends on its own, checking the monitors after each
  // pass. The import is won back from an owner that may have stopped because
  // the user switched it off within the last second, which this server has
  // not followed yet, so it reads the settings again first. A watch the
  // user's removal ended removes its import.
  async #keepCurrent(selection: Selection, signal: AbortSignal): Promise<void> {
    const connector = this.connector(selection.connector);
    using settings = this.#open();
    const directory = settings.directory(selection);
    await using _owner = await owners(settings, directory).campaign({
      timeout: Number.POSITIVE_INFINITY,
      signal,
    });
    if (!keptCurrent(settings).has(directory)) return;
    try {
      await connector.watch(
        settings,
        selection,
        {
          begin: () => ({
            progress() {},
            finish: () => void this.#check().catch(() => undefined),
            fail() {},
          }),
        },
        signal,
      );
    } finally {
      if (settings.staleImports().includes(directory))
        rmSync(directory, { recursive: true, force: true });
    }
  }

  // Registers a monitor for the chat that asked; see Monitors.add.
  async addMonitor(name: string, thread: string): Promise<void> {
    await this.monitors.add(name, thread, this.#locate());
  }

  // Where each selected connector's import is, for monitors that name it as a
  // schema; one not imported yet is not found.
  #locate(): Locate {
    using settings = this.#open();
    const imports = new Map(
      settings
        .selections()
        .map((selection) => [
          selection.connector,
          settings.database(selection),
        ]),
    );
    return (name) => {
      const database = imports.get(name);
      return database !== undefined && existsSync(database)
        ? database
        : undefined;
    };
  }

  async options(name: string) {
    const connector = this.connector(name);
    return {
      connector: name,
      choices: Object.fromEntries(await connector.choiceRows()),
      permissions: connector.guidance(),
      datedBy: connector.datedBy,
      note: connector.note,
    };
  }
}

// Each import the user keeps current, by its folder.
function keptCurrent(settings: Settings): Map<string, Selection> {
  const watched = settings.watched();
  return new Map(
    settings
      .selections()
      .filter(({ connector }) => watched.includes(connector))
      .map((selection) => [settings.directory(selection), selection]),
  );
}

// Who owns an import: the server holding its claim, for one pass of a sync
// or for as long as it keeps the import current. The claim sits at the
// store's root, beside the settings, so the removal of an import's folder
// never deletes a claim a waiting server holds open. A copy of the CLI's
// owners() in apps/apple/cli/src/imports.ts: change both.
function owners(settings: Settings, directory: string): SqliteElection {
  const name = relative(settings.root, directory).replaceAll(sep, '.');
  return new SqliteElection({
    directory: settings.root,
    claimFile: `${name}.owner.lock`,
    epochFile: `${name}.owner.epoch`,
  });
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
