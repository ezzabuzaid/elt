import { Copy } from './core/copy.ts';
import { Pipeline } from './core/pipeline.ts';
import { SQLiteDestination } from './destinations/sqlite/sqlite-destination.ts';
import { MacOSDocumentParser } from './parsers/macos-document-parser.ts';
import { AppleNotesSource } from './sources/apple-notes/apple-notes-source.ts';

const source = new AppleNotesSource();
const destination = new SQLiteDestination({
  path: 'outputs/attachments.sqlite',
});
const pipeline = new Pipeline({
  source,
  destination,
  steps: [
    new Copy(
      source.attachments,
      destination.table('attachments', (c) => [
        c.text('id'),
        c.text('name'),
        c.text('containerId'),
        c
          .text('content')
          .from(source.attachments.file)
          .parse(new MacOSDocumentParser()),
        c.blob('bytes').from(source.attachments.file),
      ]),
      { syncMode: 'full_refresh', destinationSyncMode: 'overwrite' },
    ),
  ],
});

console.table(
  (await pipeline.run()).map(({ copy, count }) => ({
    table: copy.to.name,
    count,
  })),
);
