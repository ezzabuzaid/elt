import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Copy, Pipeline, PipelineError, SQLiteDestination } from 'elt';
import {
  AppleNotesSource,
  MacOSDocumentParser,
  NotesUnavailableError,
} from './index.ts';

try {
  const path = resolve('outputs/apple-notes.sqlite');
  await mkdir(dirname(path), { recursive: true });
  const source = new AppleNotesSource();
  const destination = new SQLiteDestination({ path });
  const pipeline = new Pipeline({
    source,
    destination,
    steps: [
      new Copy(
        source.accounts,
        destination.table('raw_accounts', (columns) => [
          columns.text('id').primaryKey(),
          columns.text('name').notNull(),
        ]),
      ),
      new Copy(source.folders, destination.table('raw_folders')),
      new Copy(source.notes, destination.table('raw_notes')),
      new Copy(
        source.attachments,
        destination.table('raw_attachments', (columns) => [
          columns.text('id'),
          columns.text('containerId'),
          columns.text('name'),
          columns
            .text('content')
            .from(source.attachments.file)
            .parse(new MacOSDocumentParser()),
          columns.blob('bytes').from(source.attachments.file),
        ]),
      ),
    ],
  });
  const results = await pipeline.run();
  console.table(
    results.map(({ copy, count }) => ({
      stream: copy.from.name,
      table: copy.to.name,
      count,
    })),
  );
  console.log(`Loaded Apple Notes into ${path}`);
  using database = new DatabaseSync(path, { readOnly: true });
  console.table(
    database
      .prepare(`
      SELECT
        notes.name AS note,
        attachments.name AS attachment,
        attachments.content,
        length(attachments.bytes) AS byte_length
      FROM raw_attachments AS attachments
      LEFT JOIN raw_notes AS notes ON notes.id = attachments.containerId
      ORDER BY notes.name, attachments.name, attachments.id
    `)
      .all(),
  );
} catch (error) {
  const cause = error instanceof PipelineError ? error.cause : error;
  if (!(cause instanceof NotesUnavailableError)) throw error;
  console.error(cause.message);
  process.exitCode = 1;
}
