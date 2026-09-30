import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Connection, Copy, LocalFiles, type Stream } from 'elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
} from 'elt-sqlite';
import { apps } from './apps.ts';
import { type AppConfiguration, importDirectory } from './settings.ts';

const attachmentRef = {
  type: ['string', 'null'],
  description: 'Managed local copy when bytes are available',
};

// One app's import in its import directory: data.sqlite for records and the
// _apple_catalog table, checkpoints.sqlite, and files/ for attachment copies.
// Publishing the catalog first lets readers see the tables before a pass ends.
export async function appConnection(directory: string, item: AppConfiguration) {
  const { app, scope, includeAttachments } = item;
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
  {
    using data = new DatabaseSync(destination.path);
    data.exec(
      'CREATE TABLE IF NOT EXISTS _apple_catalog (name TEXT PRIMARY KEY, schema_json TEXT NOT NULL, coverage_json TEXT NOT NULL);',
    );
    const publish = data.prepare(
      'INSERT INTO _apple_catalog VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET schema_json=excluded.schema_json, coverage_json=excluded.coverage_json',
    );
    for (const stream of streams)
      publish.run(
        stream.name,
        JSON.stringify(
          withFiles(stream)
            ? {
                ...stream.jsonSchema,
                properties: {
                  ...(stream.jsonSchema.properties as object | undefined),
                  attachmentRef,
                },
              }
            : stream.jsonSchema,
        ),
        JSON.stringify(source.coverage(stream)),
      );
  }
  return new Connection({
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
          withFiles(stream)
            ? destination.table(stream.name, (columns) => [
                ...SQLiteColumns.fromSchema(stream.jsonSchema),
                columns.text('attachmentRef').from(stream.file.store(files)),
              ])
            : destination.table(stream.name),
          {
            id: `${app}:${stream.name}`,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          },
        ),
    ),
  });
}
