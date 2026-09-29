import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CopyConfiguration, StreamStatus } from 'elt';
import { type App, appNames, apps } from './apps.ts';
import { configurationSchema, lockOperations, Settings } from './settings.ts';
import { importApp } from './sync.ts';

// Setup and sync for the Codex plugin. Agents read the imported data.sqlite
// files directly; this class only writes them.
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
    return {
      configured: configuration !== null,
      apps: (configuration?.apps ?? []).map((item) => {
        const database = join(this.directory, item.app, 'data.sqlite');
        return {
          ...item,
          database: existsSync(database) ? database : null,
          sync: settings.syncResult(item.app) ?? null,
          permissions: apps[item.app].permissions,
        };
      }),
    };
  }

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
      using _lock = lockOperations(this.directory);
      const previous = settings.configuration();
      const selection = (from: typeof configuration | null, app: App) =>
        JSON.stringify(from?.apps.find((item) => item.app === app) ?? null);
      const changed = appNames.filter(
        (app) => selection(previous, app) !== selection(configuration, app),
      );
      for (const app of changed)
        rmSync(join(this.directory, app), { recursive: true, force: true });
      settings.saveConfiguration(configuration, changed);
    }
    return this.status();
  }

  async options(app: App) {
    const definition = apps[app];
    const source = definition.source(definition.defaultScope?.() ?? {});
    const catalog = await source.discover();
    const choices: Record<string, unknown[]> = {};
    for await (const message of source.read(
      definition.choices.map(
        (name) =>
          new CopyConfiguration(catalog.get(name), {
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
      if (!('type' in message))
        choices[message.stream] = [
          ...(choices[message.stream] ?? []),
          message.data,
        ];
    }
    return {
      app,
      choices,
      permissions: definition.permissions,
      dateField: definition.dateField,
      defaultScope: definition.defaultScope?.(),
      note: definition.note,
    };
  }

  async sync(only?: readonly App[]) {
    {
      using settings = new Settings(this.directory);
      using _lock = lockOperations(this.directory);
      const configuration = settings.configuration();
      if (configuration === null)
        throw new Error(
          'Choose the Apple apps to connect with Set up Apple first.',
        );
      if (
        only?.some(
          (app) => !configuration.apps.some((item) => item.app === app),
        )
      )
        throw new Error('Sync can only access apps selected during setup.');
      for (const item of configuration.apps) {
        if (only !== undefined && !only.includes(item.app)) continue;
        const { lastSucceededAt } = settings.syncResult(item.app) ?? {};
        settings.saveSyncResult(item.app, {
          state: 'running',
          startedAt: new Date().toISOString(),
          lastSucceededAt,
        });
        settings.saveSyncResult(
          item.app,
          await importApp(this.directory, item, lastSucceededAt),
        );
      }
    }
    return this.status();
  }
}
