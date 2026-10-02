import { relative } from 'node:path';

import type { ApplePlugin, ImportSync } from './apple-plugin.ts';

// What a chat's hooks add to the model's context: each selected app, where its
// import lives and how its last pass went. A chat keeps it until it changes,
// so times are instants, not "minutes ago".

const progress = (sync: ImportSync | null, guidance: string): string => {
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
    case 'partial':
      return `partly synced at ${sync.completedAt}: ${sync.error} ${guidance}`;
    case 'failed':
      return `last sync failed at ${sync.completedAt}: ${sync.error} ${guidance}; ${since}`;
  }
};

// What a reader can do with an app: wait for its first import, read it, or
// not reach it. A pass starting or finishing over data already there changes
// nothing a reader does.
const readiness = (sync: ImportSync | null) => {
  if (sync === null) return 'importing';
  if (sync.state === 'failed' || sync.state === 'partial')
    return [sync.state, sync.error];
  if (sync.lastSucceededAt === null) return 'importing';
  return 'readable';
};

// state changes only when the selection, an import's file, what a reader
// can do with it, or the connectors that could not load change.
export function chatStatus(plugin: ApplePlugin): {
  state: string;
  text: string;
} {
  const selected = plugin.status().apps;
  const broken = plugin.broken.map(
    ({ title, error }) => `- ${title} could not be loaded: ${error}`,
  );
  const state = (apps: unknown) =>
    JSON.stringify({ apps, broken: plugin.broken });
  if (selected.length === 0)
    return {
      state: state([]),
      text: [
        'Apple: no apps are set up. Use $setup-apple when the user asks about their Apple apps.',
        ...broken,
      ].join('\n'),
    };
  return {
    state: state(
      selected.map(({ app, database, sync }) => [
        app,
        database,
        readiness(sync),
      ]),
    ),
    text: [
      `Apple apps the user connected, each imported into its own SQLite file under "${plugin.directory}". Read them as $query-apple describes.`,
      ...selected.map(
        ({ app, database, sync }) =>
          `- ${plugin.app(app).title}: ${progress(sync, plugin.app(app).guidance())}. ${database === null ? 'No database yet.' : `Database: ${relative(plugin.directory, database)}`}`,
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
