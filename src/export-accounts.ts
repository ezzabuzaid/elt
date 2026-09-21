import { resolve } from 'node:path';
import { Copy } from './core/copy.ts';
import { Pipeline, PipelineError } from './core/pipeline.ts';
import { MarkdownDestination } from './destinations/markdown/markdown-destination.ts';
import { AppleNotesSource } from './sources/apple-notes/apple-notes-source.ts';
import { NotesUnavailableError } from './sources/apple-notes/apple-notes-stream.ts';

try {
  const source = new AppleNotesSource();
  const destination = new MarkdownDestination({
    path: resolve('outputs/markdown'),
  });
  const pipeline = new Pipeline({
    source,
    destination,
    steps: [
      new Copy(
        source.accounts,
        destination.file('accounts.md', { title: 'name' }),
      ),
      new Copy(
        source.accounts,
        destination.folder('accounts', { title: 'name' }),
      ),
    ],
  });

  const results = await pipeline.run();
  console.table(
    results.map(({ copy, count }) => ({ target: copy.to.name, count })),
  );
  console.log(`Exported accounts to ${destination.path}`);
} catch (error) {
  const cause = error instanceof PipelineError ? error.cause : error;
  if (!(cause instanceof NotesUnavailableError)) throw error;
  console.error(cause.message);
  process.exitCode = 1;
}
