import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, Copy, LocalFiles, type Stream } from 'elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
} from 'elt-sqlite';
import { importDirectory, type Selection } from 'import-store';
import { appNamed, apps } from './apps.ts';

const snake = (name: string) =>
  name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

// One app's import in its import directory: data.sqlite, where each stream
// loads into raw_<stream> and is read through its <snake_stream> view,
// checkpoints.sqlite, and files/ for attachment copies. Returns the destination
// too, typed, for the history and catalog installed in its file.
export async function appConnection(directory: string, item: Selection) {
  const { scope, includeAttachments } = item;
  const app = appNamed(item.app);
  const source = apps[app].source(scope);
  const catalog = await source.discover();
  const omitted = new Set(
    Object.keys(scope).length > 0 ? (apps[app].unscoped ?? []) : [],
  );
  const streams = catalog.streams.filter((stream) => !omitted.has(stream.name));
  const withFiles = (stream: Stream) =>
    includeAttachments &&
    stream.supportsFileTransfer === true &&
    !apps[app].storeCopies?.includes(stream.name);
  const importPath = importDirectory(directory, item);
  mkdirSync(importPath, { recursive: true, mode: 0o700 });
  const destination = new SQLiteDestination({
    path: join(importPath, 'data.sqlite'),
  });
  const files = new LocalFiles({ directory: join(importPath, 'files') });
  const connection = new Connection({
    name: app,
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(importPath, 'checkpoints.sqlite'),
    }),
    steps: streams.map(
      (stream) =>
        new Copy(
          stream,
          destination
            .table(
              `raw_${stream.name}`,
              withFiles(stream)
                ? (columns) => [
                    ...SQLiteColumns.fromSchema(stream.jsonSchema),
                    columns
                      .text('attachmentRef')
                      .from(stream.file.store(files)),
                  ]
                : undefined,
            )
            .withReaderView(snake(stream.name)),
          {
            id: `${app}:${stream.name}`,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          },
        ),
    ),
  });
  return { connection, destination };
}
