import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Copy } from './core/copy.ts';
import { Pipeline, PipelineError } from './core/pipeline.ts';
import { SQLiteDestination } from './destinations/sqlite/sqlite-destination.ts';
import { MacOSDocumentParser } from './parsers/macos-document-parser.ts';
import { AppleNotesSource } from './sources/apple-notes/apple-notes-source.ts';
import { NotesUnavailableError } from './sources/apple-notes/apple-notes-stream.ts';

try {
  const path = resolve('outputs/apple-notes.sqlite');
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
        { syncMode: 'full_refresh', destinationSyncMode: 'overwrite' },
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
        { syncMode: 'full_refresh', destinationSyncMode: 'overwrite' },
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
