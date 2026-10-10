import type { PassStatus } from '@workspace/elt-sqlite';
import type { Selection } from '@workspace/settings';

import type { ApplePlugin } from './apple-plugin.ts';
import { passFailure } from './pass-failure.ts';

// The plugin page's native Settings section (the openai/settings MCP
// extension): one switch per connector, described by that connector's import
// status. Scopes other than a connector's default are chosen in the setup
// forms.

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
  item: Selection & {
    sync: PassStatus | null;
    permissions: string;
  },
  now: Date,
): string {
  const { sync, permissions } = item;
  if (sync === null) return 'Waiting to import.';
  switch (sync.state) {
    case 'running':
      return `Importing since ${new Date(sync.startedAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}.`;
    case 'cancelled':
      return 'Stopped: resumes the next time Codex runs the Apple plugin.';
    case 'succeeded':
      return `Synced ${ago(sync.completedAt, now)} · ${plugin.connectors.find(({ name }) => name === item.connector)?.describe(item.scope) ?? 'its saved selection'}.`;
    case 'partial':
      return `Partly synced ${ago(sync.completedAt, now)}: ${passFailure(sync, permissions)}`;
    case 'failed':
      return `Last sync failed: ${passFailure(sync, permissions)}`;
  }
}

export function settingsRead(plugin: ApplePlugin, now = new Date()) {
  const selected = plugin.status().connectors;
  const connected = new Map(selected.map((item) => [item.connector, item]));
  // Every loaded connector, then each selected connector that is not loaded,
  // so it can still be switched off.
  const switches = [
    ...plugin.connectors.map(({ name, title }) => ({ name, title })),
    ...selected
      .filter(
        ({ connector }) =>
          !plugin.connectors.some(({ name }) => name === connector),
      )
      .map(({ connector, title }) => ({ name: connector, title })),
  ];
  const names = switches.map(({ name }) => name);
  return {
    schema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        switches.map(({ name, title }) => {
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
        title: 'Connectors',
        items: names.map((name) => ({
          kind: 'property' as const,
          property: name,
        })),
      },
    ],
  };
}

// Connects each connector switched on with its default scope, disconnects
// each one switched off, and keeps every other connector's scope as it was.
export async function settingsUpdate(
  plugin: ApplePlugin,
  set: Partial<SettingsValues>,
) {
  const current = plugin.status().connectors;
  const kept = current
    .filter(({ connector }) => set[connector] !== false)
    .map(({ connector, scope, includeAttachments }) => ({
      connector,
      scope,
      includeAttachments,
    }));
  const added = plugin.connectors
    .map(({ name }) => name)
    .filter(
      (connector) =>
        set[connector] === true &&
        !current.some((item) => item.connector === connector),
    )
    .map((connector) => ({ connector, scope: {}, includeAttachments: true }));
  await plugin.configure({ connectors: [...kept, ...added] });
  return { values: settingsRead(plugin).values };
}
