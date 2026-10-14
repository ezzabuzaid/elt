import type { PassStatus } from '@workspace/elt-sqlite';
import type { Selection } from '@workspace/settings';

import { type ApplePlugin, configurationSchema } from './apple-plugin.ts';
import type {
  ConnectorChoices,
  ConnectorRow,
  ConnectorSelection,
} from './page/contract.ts';
import { passFailure } from './pass-failure.ts';

// What the Apple page shows and changes: one row per connector, described by
// its import's status, and one connector's selection at a time.

// One connector's selection as the page sends it; what it leaves out takes
// the defaults setup uses.
export const connectorSelectionSchema =
  configurationSchema.shape.connectors.element.omit({ connector: true });

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
  sync: PassStatus,
  covers: string,
  permissions: string,
  now: Date,
): string {
  switch (sync.state) {
    // A pass a killed process left reads running until the next pass, so its
    // date and age show it is not today's.
    case 'running':
      return `Importing since ${new Date(sync.startedAt).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} (${ago(sync.startedAt, now)}).`;
    case 'cancelled':
      return 'Stopped before it finished.';
    case 'succeeded':
      return `Synced ${ago(sync.completedAt, now)} · ${covers}.`;
    case 'partial':
      return `Partly synced ${ago(sync.completedAt, now)}: ${passFailure(sync, permissions)}`;
    case 'failed':
      return `Last sync failed: ${passFailure(sync, permissions)}`;
  }
}

type SelectedConnector = ReturnType<
  ApplePlugin['status']
>['connectors'][number];

function loadedStatus(
  connector: ApplePlugin['connectors'][number],
  item: SelectedConnector | undefined,
  now: Date,
): ConnectorRow['status'] {
  if (item === undefined)
    return { state: 'off', text: 'Not connected.', fullDiskAccess: false };
  if (item.sync === null)
    return {
      state: 'waiting',
      text: 'Waiting to import.',
      fullDiskAccess: false,
    };
  return {
    state: item.sync.state,
    text: describe(
      item.sync,
      connector.describe(item.scope),
      item.permissions,
      now,
    ),
    fullDiskAccess:
      connector.fullDiskAccess && item.sync.failureType === 'config',
  };
}

// Every loaded connector, then each selected connector that is not loaded,
// so it can still be switched off. Rows keep their title order whatever their
// state, so switching a connector never moves its row.
export function connectorRows(plugin: ApplePlugin): ConnectorRow[] {
  const now = new Date();
  const selected = plugin.status().connectors;
  const loaded = plugin.connectors.map((connector): ConnectorRow => {
    const item = selected.find(
      ({ connector: name }) => name === connector.name,
    );
    const selection =
      item === undefined
        ? null
        : { scope: item.scope, includeAttachments: item.includeAttachments };
    return {
      name: connector.name,
      title: connector.title,
      loaded: true,
      selection,
      status: loadedStatus(connector, item, now),
      narrowsBy: {
        accountIds: connector.narrowsBy('accountIds'),
        collectionIds: connector.narrowsBy('collectionIds'),
      },
      datedBy: connector.datedBy,
    };
  });
  const missing = selected
    .filter(
      ({ connector }) =>
        !plugin.connectors.some(({ name }) => name === connector),
    )
    .map((item): ConnectorRow => ({
      name: item.connector,
      title: item.title,
      loaded: false,
      selection: {
        scope: item.scope,
        includeAttachments: item.includeAttachments,
      },
      status: {
        state: item.sync === null ? 'waiting' : item.sync.state,
        text: item.permissions,
        fullDiskAccess: false,
      },
      narrowsBy: { accountIds: false, collectionIds: false },
      datedBy: null,
    }));
  return [
    ...loaded.toSorted((a, b) => a.title.localeCompare(b.title)),
    ...missing,
  ];
}

// Connects, narrows or disconnects one connector, and returns the rows with
// the imports the change creates. Every other connector keeps its stored
// selection, so a page that read the selection before another chat changed it
// does not undo that change.
export async function updateConnector(
  plugin: ApplePlugin,
  connector: string,
  selection: ConnectorSelection | null,
): Promise<{ connectors: ConnectorRow[]; newImports: Selection[] }> {
  const current = plugin
    .status()
    .connectors.map(({ connector, scope, includeAttachments }) => ({
      connector,
      scope,
      includeAttachments,
    }));
  const replaced = current.flatMap((item) => {
    if (item.connector !== connector) return [item];
    if (selection === null) return [];
    return [{ connector, ...selection }];
  });
  const added =
    selection !== null && !current.some((item) => item.connector === connector)
      ? [{ connector, ...selection }]
      : [];
  const newImports = await plugin.configure({
    connectors: [...replaced, ...added],
  });
  return { connectors: connectorRows(plugin), newImports };
}

// What a connector can be narrowed to, read from its app, which may make
// macOS ask for access.
export async function connectorChoices(
  plugin: ApplePlugin,
  name: string,
): Promise<ConnectorChoices> {
  const connector = plugin.connector(name);
  return {
    choices: (await connector.listChoices()).map(
      ({ scope, title, options }) => ({ scope, title, options }),
    ),
    datedBy: connector.datedBy,
    defaultSelection: {
      ...connectorSelectionSchema.parse({}),
      scope: connector.defaultScope(),
    },
    note: connector.note,
  };
}
