import type {
  AppConfiguration,
  ApplePlugin,
  ImportSync,
} from './apple-plugin.ts';
import { type App, appNames, apps } from './apps.ts';

// The plugin page's native Settings section (the openai/settings MCP
// extension): one switch per app, described by that app's import status.
// Scopes other than an app's default are chosen in the setup forms.

export type SettingsValues = Record<App, boolean>;

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function ago(instant: string, now: Date): string {
  const seconds = Math.round((Date.parse(instant) - now.getTime()) / 1000);
  for (const [unit, size] of [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ] as const)
    if (Math.abs(seconds) >= size)
      return relative.format(Math.round(seconds / size), unit);
  return 'just now';
}

// What the import covers, in the words the setup forms use.
function coverage({ app, scope }: AppConfiguration): string {
  const parts: string[] = [];
  if (scope.accountIds !== undefined)
    parts.push(
      `${scope.accountIds.length} account${scope.accountIds.length === 1 ? '' : 's'}`,
    );
  const collection = apps[app].choices.find(
    ({ scope: kind }) => kind === 'collectionIds',
  )?.stream;
  if (scope.collectionIds !== undefined && collection !== undefined)
    parts.push(
      `${scope.collectionIds.length} ${scope.collectionIds.length === 1 ? collection.replace(/(x)es$|s$/, '$1') : collection}`,
    );
  if (scope.startAt !== undefined)
    parts.push(`from ${scope.startAt.slice(0, 10)}`);
  if (scope.endAt !== undefined)
    parts.push(
      `until ${new Date(Date.parse(scope.endAt) - 1).toISOString().slice(0, 10)}`,
    );
  return parts.length === 0 ? 'everything' : parts.join(', ');
}

const failure = (app: App, error: string) =>
  `${error} ${apps[app].permissions}`;

function describe(
  item: AppConfiguration & { sync: ImportSync | null },
  now: Date,
): string {
  const { sync } = item;
  if (sync === null) return 'Waiting to import.';
  switch (sync.state) {
    case 'running':
      return `Importing since ${new Date(sync.startedAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}.`;
    case 'interrupted':
      return 'Paused: resumes the next time Codex runs the Apple plugin.';
    case 'succeeded':
      return `Synced ${ago(sync.completedAt, now)} · ${coverage(item)}.`;
    case 'partial':
      return `Partly synced ${ago(sync.completedAt, now)}: ${failure(item.app, sync.error)}`;
    case 'failed':
      return `Last sync failed: ${failure(item.app, sync.error)}`;
  }
}

export function settingsRead(plugin: ApplePlugin, now = new Date()) {
  const connected = new Map(
    plugin.status().apps.map((item) => [item.app, item]),
  );
  return {
    schema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        appNames.map((app) => {
          const item = connected.get(app);
          return [
            app,
            {
              type: 'boolean' as const,
              title: apps[app].title,
              description:
                item === undefined ? 'Not connected.' : describe(item, now),
            },
          ];
        }),
      ),
    },
    values: Object.fromEntries(
      appNames.map((app) => [app, connected.has(app)]),
    ) as SettingsValues,
    layout: [
      {
        kind: 'group' as const,
        title: 'Apps',
        items: appNames.map((app) => ({
          kind: 'property' as const,
          property: app,
        })),
      },
    ],
  };
}

// Connects each app switched on with its default scope, disconnects each
// app switched off, and keeps every other app's scope as it was.
export function settingsUpdate(
  plugin: ApplePlugin,
  set: Partial<SettingsValues>,
) {
  const current = plugin.status().apps;
  const kept = current
    .filter(({ app }) => set[app] !== false)
    .map(({ app, scope, includeAttachments }) => ({
      app,
      scope,
      includeAttachments,
    }));
  const added = appNames
    .filter(
      (app) => set[app] === true && !current.some((item) => item.app === app),
    )
    .map((app) => ({ app }));
  plugin.configure({ apps: [...kept, ...added] });
  return { values: settingsRead(plugin).values };
}
