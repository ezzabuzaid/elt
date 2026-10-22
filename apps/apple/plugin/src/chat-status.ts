import { join, relative } from 'node:path';

import { peopleConnectors } from '@workspace/apple-people/people';
import type { PassStatus } from '@workspace/elt-sqlite';

import type { ApplePlugin } from './apple-plugin.ts';
import { connectorLink, pageLink } from './page/contract.ts';
import { passFailure } from './pass-failure.ts';

// What a chat's hooks add to the model's context: each selected connector,
// where its import lives, how its last pass went and the presets a reader can
// load, and the people model that reads across them. A chat keeps it until it
// changes, so times are instants, not "minutes ago".

const progress = (sync: PassStatus | null, guidance: string): string => {
  if (sync === null) return 'waiting for its first import';
  // currentAsOf is the oldest stream's current_as_of, so it is null while any
  // stream has not loaded completely, even when others already hold rows.
  const since =
    sync.currentAsOf === null
      ? "not every stream has loaded completely yet; stream_status has each stream's current_as_of"
      : `data as of ${sync.currentAsOf}`;
  switch (sync.state) {
    case 'succeeded':
      return `synced at ${sync.completedAt}; ${since}`;
    case 'running':
      return `importing since ${sync.startedAt}; ${since}`;
    case 'cancelled':
      return `its last pass was stopped before it finished; ${since}`;
    case 'partial':
      return `partly synced at ${sync.completedAt}: ${passFailure(sync, guidance)}; ${since}`;
    case 'failed':
      return `last sync failed at ${sync.completedAt}: ${passFailure(sync, guidance)}; ${since}`;
  }
};

// A failed or partial pass is one the user may fix, such as by granting access.
const needsTheUser = (sync: PassStatus | null) =>
  sync?.state === 'failed' || sync?.state === 'partial';

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
export function chatStatus(plugin: ApplePlugin): {
  state: string;
  text: string;
} {
  const selected = plugin.status().connectors;
  const broken = plugin.broken.map(
    ({ title, error }) => `- ${title} could not be loaded: ${error}`,
  );
  const state = (connectors: unknown) =>
    JSON.stringify({ connectors, broken: plugin.broken });
  if (selected.length === 0)
    return {
      state: state([]),
      text: [
        `Apple: no connectors are set up. Use $setup-apple when the user asks about their Apple apps; the user can also choose connectors on the Apple page: ${pageLink}`,
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
      rows.map(({ connector, database, sync, presets, content }) => [
        connector,
        database,
        readiness(sync),
        content,
        presets.map(({ file }) => file),
      ]),
    ),
    text: [
      `Apple connectors the user set up, each imported into its own SQLite file under "${plugin.directory}". Read them as $query-apple describes. The user changes them on the Apple page: ${pageLink}`,
      `People, everyone the user dealt with across these apps: attach the imports of ${peopleConnectors.join(', ')} under those names and read "${join(plugin.install, 'server/people.sql')}", as $apple-people describes.`,
      ...rows.map(
        ({
          connector,
          title,
          database,
          sync,
          permissions,
          loaded,
          presets,
          content,
        }) => {
          const page = `Its Apple page: ${connectorLink(connector)}`;
          // A selected connector that is not loaded does not import.
          if (loaded === undefined) return `- ${title}: ${permissions} ${page}`;
          const where =
            database === null
              ? 'No database yet.'
              : `Database: ${relative(plugin.directory, database)}`;
          const fix = needsTheUser(sync) ? ` ${page}` : '';
          const presetsLine =
            presets.length === 0
              ? []
              : [
                  `  Presets in "${loaded.presetsFolder}": ${presets.map(({ name }) => name).join(', ')}`,
                ];
          return [
            `- ${title}: ${progress(sync, permissions)}. ${where}${fix}`,
            ...content.map((line) => `  ${line}`),
            ...presetsLine,
          ].join('\n');
        },
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
  return (event: 'SessionStart' | 'UserPromptSubmit'): string | null => {
    const status = chatStatus(plugin);
    if (event === 'UserPromptSubmit' && status.state === sent) return null;
    sent = status.state;
    return status.text;
  };
}
