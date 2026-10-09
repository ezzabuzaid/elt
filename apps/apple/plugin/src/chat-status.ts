import { relative } from 'node:path';

import type { PassStatus } from '@workspace/elt-sqlite';

import type { ApplePlugin } from './apple-plugin.ts';
import { passFailure } from './pass-failure.ts';

// What a chat's hooks add to the model's context: each selected connector,
// where its import lives, how its last pass went and the presets a reader can
// load. A chat keeps it until it changes, so times are instants, not "minutes
// ago".

const progress = (sync: PassStatus | null, guidance: string): string => {
  if (sync === null) return 'waiting for its first import';
  const since =
    sync.lastSucceededAt === null
      ? 'no data yet'
      : `data as of ${sync.lastSucceededAt}`;
  switch (sync.state) {
    case 'succeeded':
      return `synced at ${sync.completedAt}`;
    case 'running':
      return `importing since ${sync.startedAt}; ${since}`;
    case 'interrupted':
      return `its last pass stopped unfinished and resumes when Codex runs the Apple plugin; ${since}`;
    case 'cancelled':
      return `its last pass was stopped and resumes when Codex runs the Apple plugin; ${since}`;
    case 'partial':
      return `partly synced at ${sync.completedAt}: ${passFailure(sync, guidance)}`;
    case 'failed':
      return `last sync failed at ${sync.completedAt}: ${passFailure(sync, guidance)}; ${since}`;
  }
};

// What a reader can do with a connector: wait for its first import, read it, or
// not reach it. A pass starting or finishing over data already there changes
// nothing a reader does.
const readiness = (sync: PassStatus | null) => {
  if (sync === null) return 'importing';
  if (sync.state === 'failed' || sync.state === 'partial')
    return [sync.state, sync.error];
  if (sync.lastSucceededAt === null) return 'importing';
  return 'readable';
};

// state changes only when the selection, an import's file, what a reader
// can do with it, its presets, or the connectors that could not load change.
export async function chatStatus(plugin: ApplePlugin): Promise<{
  state: string;
  text: string;
}> {
  const selected = (await plugin.status()).connectors;
  const broken = plugin.broken.map(
    ({ title, error }) => `- ${title} could not be loaded: ${error}`,
  );
  const state = (connectors: unknown) =>
    JSON.stringify({ connectors, broken: plugin.broken });
  if (selected.length === 0)
    return {
      state: state([]),
      text: [
        'Apple: no connectors are set up. Use $setup-apple when the user asks about their Apple apps.',
        ...broken,
      ].join('\n'),
    };
  const rows = selected.map((item) => {
    const loaded = plugin.connectors.find(
      ({ name }) => name === item.connector,
    );
    return { ...item, loaded, presets: loaded?.presets() ?? [] };
  });
  return {
    state: state(
      rows.map(({ connector, database, sync, presets }) => [
        connector,
        database,
        readiness(sync),
        presets.map(({ file }) => file),
      ]),
    ),
    text: [
      `Apple connectors the user set up, each imported into its own SQLite file under "${plugin.directory}". Read them as $query-apple describes.`,
      ...rows.map(({ title, database, sync, permissions, loaded, presets }) =>
        // A selected connector that is not loaded does not import.
        loaded === undefined
          ? `- ${title}: ${permissions}`
          : [
              `- ${title}: ${progress(sync, permissions)}. ${database === null ? 'No database yet.' : `Database: ${relative(plugin.directory, database)}`}`,
              ...(presets.length === 0
                ? []
                : [
                    `  Presets in "${loaded.presetsFolder}": ${presets.map(({ name }) => name).join(', ')}`,
                  ]),
            ].join('\n'),
      ),
      ...broken,
    ].join('\n'),
  };
}

// The status to add to one chat's context: always when the chat starts or
// compacts, and before a prompt only once the status changed since it was
// last sent.
export function chatContext(plugin: ApplePlugin) {
  let sent: string | undefined;
  return async (
    event: 'SessionStart' | 'UserPromptSubmit',
  ): Promise<string | null> => {
    const status = await chatStatus(plugin);
    if (event === 'UserPromptSubmit' && status.state === sent) return null;
    sent = status.state;
    return status.text;
  };
}
