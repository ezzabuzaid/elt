import { relative } from 'node:path';
import type { ApplePlugin, ImportSync } from './apple-plugin.ts';
import { type App, apps } from './apps.ts';

// What a chat's hooks add to the model's context: each selected app, where its
// import lives and how its last pass went. A chat keeps it until it changes,
// so times are instants, not "minutes ago".

const progress = (sync: ImportSync | null, app: App): string => {
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
      return `partly synced at ${sync.completedAt}: ${sync.error} ${apps[app].permissions}`;
    case 'failed':
      return `last sync failed at ${sync.completedAt}: ${sync.error} ${apps[app].permissions}; ${since}`;
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

// state changes only when the selection, an import's file or what a reader
// can do with it changes.
export function chatStatus(plugin: ApplePlugin): {
  state: string;
  text: string;
} {
  const selected = plugin.status().apps;
  if (selected.length === 0)
    return {
      state: '[]',
      text: 'Apple: no apps are set up. Use $setup-apple when the user asks about their Apple apps.',
    };
  return {
    state: JSON.stringify(
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
          `- ${apps[app].title}: ${progress(sync, app)}. ${database === null ? 'No database yet.' : `Database: ${relative(plugin.directory, database)}`}`,
      ),
    ].join('\n'),
  };
}
