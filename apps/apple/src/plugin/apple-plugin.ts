import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CopyConfiguration, StreamStatus } from 'elt';
import { type App, apps, type ChoiceRows } from './apps.ts';
import { leaderRunning } from './freshness.ts';
import {
  configurationSchema,
  importDirectory,
  removeStaleImports,
  Settings,
} from './settings.ts';

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
      configured: configuration !== null,
      apps: (configuration?.apps ?? []).map((item) => {
        const importPath = importDirectory(this.directory, item);
        const database = join(importPath, 'data.sqlite');
        const sync = settings.syncResult(importPath) ?? null;
        return {
          ...item,
          database: existsSync(database) ? database : null,
          sync:
            sync?.state === 'running' && !leading
              ? { ...sync, state: 'interrupted' as const }
              : sync,
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
      settings.saveConfiguration(
        configuration,
        configuration.apps.map((item) => importDirectory(this.directory, item)),
      );
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

  // Waits, up to four minutes, while an app's import has not finished its
  // first pass or is running one, so an answer can use current data.
  async sync(only?: readonly App[]) {
    const configuration = this.status();
    if (!configuration.configured)
      throw new Error(
        'Choose the Apple apps to connect with Set up Apple first.',
      );
    if (
      only?.some((app) => !configuration.apps.some((item) => item.app === app))
    )
      throw new Error('Sync can only access apps selected during setup.');
    const deadline = Date.now() + 240_000;
    for (;;) {
      const status = this.status();
      const leading = leaderRunning(this.directory);
      const waiting = status.apps.some(
        ({ app, sync }) =>
          (only === undefined || only.includes(app)) &&
          (sync?.state === 'running' || (sync === null && leading)),
      );
      if (!waiting || Date.now() >= deadline) return status;
      await sleep(1_000);
    }
  }
}
