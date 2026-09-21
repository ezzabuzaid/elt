import { resolve } from 'node:path';
import { Copy } from './core/copy.ts';
import { Pipeline, PipelineError } from './core/pipeline.ts';
import { SQLiteDestination } from './destinations/sqlite/sqlite-destination.ts';
import { AppleRemindersSource } from './sources/apple-reminders/apple-reminders-source.ts';
import { RemindersUnavailableError } from './sources/apple-reminders/apple-reminders-stream.ts';

try {
  const path = resolve('outputs/apple-reminders.sqlite');
  const source = new AppleRemindersSource();
  const destination = new SQLiteDestination({ path });
  const pipeline = new Pipeline({
    source,
    destination,
    steps: [
      new Copy(source.accounts, destination.table('raw_accounts')),
      new Copy(source.lists, destination.table('raw_lists')),
      new Copy(source.reminders, destination.table('raw_reminders')),
    ],
  });
  console.table(
    (await pipeline.run()).map(({ copy, count }) => ({
      stream: copy.from.name,
      table: copy.to.name,
      count,
    })),
  );
  console.log(`Loaded Apple Reminders into ${path}`);
} catch (error) {
  const cause = error instanceof PipelineError ? error.cause : error;
  if (!(cause instanceof RemindersUnavailableError)) throw error;
  console.error(cause.message);
  process.exitCode = 1;
}
