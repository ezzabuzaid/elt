import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  Copy,
  Pipeline,
  PipelineError,
  SQLiteCheckpointStore,
} from 'elt';
import { SQLiteColumns, SQLiteDestination } from 'elt-sqlite';
import {
  AppleMessagesSource,
  MacOSDocumentParser,
  MessagesUnavailableError,
} from './index.ts';

// Loads every Messages stream incrementally into <out>/apple-messages.sqlite.
// --chat-db reads another chat.db, for example a copy or a test fixture.
const { values } = parseArgs({
  options: {
    'chat-db': { type: 'string' },
    out: { type: 'string', default: 'outputs' },
  },
});

try {
  const out = resolve(values.out);
  await mkdir(out, { recursive: true });
  const source = new AppleMessagesSource(values['chat-db']);
  const destination = new SQLiteDestination({
    path: join(out, 'apple-messages.sqlite'),
  });
  const { streams } = await source.discover();
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(out, 'apple-messages-state.sqlite'),
    }),
    steps: streams.map(
      (stream) =>
        new Copy(
          stream,
          stream.supportsFileTransfer
            ? destination.table(`raw_${stream.name}`, (columns) => [
                ...SQLiteColumns.fromSchema(stream.jsonSchema),
                columns
                  .text('content')
                  .from(stream.file)
                  .parse(new MacOSDocumentParser()),
                columns.blob('bytes').from(stream.file),
              ])
            : destination.table(`raw_${stream.name}`),
          {
            id: `apple-messages:${stream.name}`,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
            primaryKey: [...stream.primaryKey],
          },
        ),
    ),
  });
  const results = await pipeline.run();
  console.table(
    results.map(({ copy, count, deleted }) => ({
      stream: copy.from.name,
      table: copy.to.name,
      count,
      deleted,
    })),
  );
  console.log(`Loaded Apple Messages into ${destination.path}`);
} catch (error) {
  const cause = error instanceof PipelineError ? error.cause : error;
  if (!(cause instanceof MessagesUnavailableError)) throw error;
  console.error(cause.message);
  process.exitCode = 1;
}
