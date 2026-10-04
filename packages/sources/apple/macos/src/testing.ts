import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  Connection,
  Copy,
  LocalFiles,
  Pipeline,
  type ReadMessage,
  type Source,
  type Stream,
  StreamStatus,
  readerCatalog,
  syncHistoryRelations,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  SQLiteSyncHistory,
  installSQLiteCatalog,
} from '@workspace/elt-sqlite';

// Test support shared by the Apple source packages' tests.

const snake = (name: string) =>
  name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

// One Apple source loaded as the hosts load it: every stream incrementally
// into raw_<stream> of one SQLite file, read through its documented
// <snake_stream> view, with files kept beside it.
export async function appleImport(source: Source, directory: string) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'data.sqlite');
  const destination = new SQLiteDestination({ path });
  const files = new LocalFiles({ directory: join(directory, 'files') });
  const { streams } = await source.discover();
  const connection = new Connection({
    name: 'apple',
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(directory, 'checkpoints.sqlite'),
    }),
    steps: streams.map(
      (stream) =>
        new Copy(
          stream,
          destination
            .table(
              `raw_${stream.name}`,
              stream.supportsFileTransfer
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
            id: stream.name,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          },
        ),
    ),
  });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  installSQLiteCatalog({ path });
  const read = (sql: string) => {
    using database = new DatabaseSync(path, { readOnly: true });
    return database.prepare(sql).all();
  };
  return {
    load: () => new Pipeline({ history, connections: [connection] }).run(),
    read,
    // The documented views the streams publish, beside the catalog and the
    // sync history every SQLite load has.
    views: () =>
      read(`SELECT name FROM catalog WHERE kind = 'view' ORDER BY name`)
        .map(({ name }) => name)
        .filter(
          (name) =>
            name !== readerCatalog.name &&
            !Object.values(syncHistoryRelations).some(
              (relation) => relation.name === name,
            ),
        ),
  };
}

// Each stream's records from one full-refresh read of streams.
export async function readRows(source: Source, streams: readonly Stream[]) {
  const rows = new Map<string, Record<string, unknown>[]>();
  for await (const message of source.read(
    streams.map((stream) => configured(stream)),
    new Map(),
  )) {
    if (message instanceof StreamStatus && message.status === 'FAILED')
      throw message.error;
    if ('data' in message)
      rows.set(message.stream, [
        ...(rows.get(message.stream) ?? []),
        Object(message.data),
      ]);
  }
  return (stream: Stream) => rows.get(stream.name) ?? [];
}

// The configured stream a full-refresh copy of stream reads.
export const configured = (stream: Stream) =>
  new Copy(
    stream,
    new SQLiteDestination({ path: ':memory:' }).table(stream.name),
  ).configuration;

// One read of first then second, with a write committed between them; returns
// what second read and what a later read sees.
export const acrossStreams = async (
  source: Source,
  [first, second]: [Stream, Stream],
  write: () => void,
  field: string,
) => {
  const values = (messages: readonly ReadMessage[]) =>
    messages
      .flatMap((message) =>
        'data' in message && message.stream === second.name
          ? [Reflect.get(Object(message.data), field)]
          : [],
      )
      .sort();
  const pinned: ReadMessage[] = [];
  for await (const message of source.read(
    [configured(first), configured(second)],
    new Map(),
  )) {
    pinned.push(message);
    if (
      message instanceof StreamStatus &&
      message.stream === first.name &&
      message.status === 'ENDED'
    )
      write();
  }
  const later = await Array.fromAsync(
    source.read([configured(second)], new Map()),
  );
  return { during: values(pinned), after: values(later) };
};
