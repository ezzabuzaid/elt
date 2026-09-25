import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Copy, Pipeline, PipelineError } from 'elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
} from 'elt-sqlite';
import {
  AppleNotesSource,
  MacOSDocumentParser,
  NotesUnavailableError,
} from './index.ts';

// Loads every Notes stream incrementally into <out>/apple-notes.sqlite.
// --note-store reads another NoteStore.sqlite, for example a test fixture.
const { values } = parseArgs({
  options: {
    'note-store': { type: 'string' },
    out: { type: 'string', default: 'outputs' },
  },
});

try {
  const out = resolve(values.out);
  await mkdir(out, { recursive: true });
  const source = new AppleNotesSource({ path: values['note-store'] });
  const destination = new SQLiteDestination({
    path: join(out, 'apple-notes.sqlite'),
  });
  const { streams } = await source.discover();
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(out, 'apple-notes-state.sqlite'),
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
            id: `apple-notes:${stream.name}`,
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
  console.log(`Loaded Apple Notes into ${destination.path}`);
} catch (error) {
  const cause = error instanceof PipelineError ? error.cause : error;
  if (!(cause instanceof NotesUnavailableError)) throw error;
  console.error(cause.message);
  process.exitCode = 1;
}
