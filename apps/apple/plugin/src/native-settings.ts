import type { Selection } from 'import-store';
import type { ApplePlugin, ImportSync } from './apple-plugin.ts';

// The plugin page's native Settings section (the openai/settings MCP
// extension): one switch per app, described by that app's import status.
// Scopes other than an app's default are chosen in the setup forms.

export type SettingsValues = Record<string, boolean>;

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

function describe(
  plugin: ApplePlugin,
  item: Selection & { sync: ImportSync | null },
  now: Date,
): string {
  const { sync } = item;
  const app = plugin.app(item.app);
  if (sync === null) return 'Waiting to import.';
  switch (sync.state) {
    case 'running':
      return `Importing since ${new Date(sync.startedAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}.`;
    case 'interrupted':
      return 'Paused: resumes the next time Codex runs the Apple plugin.';
    case 'succeeded':
      return `Synced ${ago(sync.completedAt, now)} · ${app.describe(item.scope)}.`;
    case 'partial':
      return `Partly synced ${ago(sync.completedAt, now)}: ${sync.error} ${app.guidance()}`;
    case 'failed':
      return `Last sync failed: ${sync.error} ${app.guidance()}`;
  }
}

export function settingsRead(plugin: ApplePlugin, now = new Date()) {
  const connected = new Map(
    plugin.status().apps.map((item) => [item.app, item]),
  );
  const names = plugin.apps.map(({ name }) => name);
  return {
    schema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        plugin.apps.map(({ name, title }) => {
          const item = connected.get(name);
          return [
            name,
            {
              type: 'boolean' as const,
              title,
              description:
                item === undefined
                  ? 'Not connected.'
                  : describe(plugin, item, now),
            },
          ];
        }),
      ),
    },
    values: Object.fromEntries(
      names.map((name) => [name, connected.has(name)]),
    ),
    layout: [
      {
        kind: 'group' as const,
        title: 'Apps',
        items: names.map((name) => ({
          kind: 'property' as const,
          property: name,
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
  const added = plugin.apps
    .map(({ name }) => name)
    .filter(
      (app) => set[app] === true && !current.some((item) => item.app === app),
    )
    .map((app) => ({ app, scope: {}, includeAttachments: true }));
  plugin.configure({ apps: [...kept, ...added] });
  return { values: settingsRead(plugin).values };
}
