import { Command as Program } from 'commander';
import { BooksApp } from './apps/books.ts';
import { CalendarApp } from './apps/calendar.ts';
import { ContactsApp } from './apps/contacts.ts';
import { MailApp } from './apps/mail.ts';
import { MessagesApp } from './apps/messages.ts';
import { NotesApp } from './apps/notes.ts';
import { RemindersApp } from './apps/reminders.ts';
import { SafariApp } from './apps/safari.ts';
import { OptionsCommand } from './commands/options.ts';
import { QueryCommand } from './commands/query.ts';
import { SetupCommand } from './commands/setup.ts';
import { StatusCommand } from './commands/status.ts';
import { SyncCommand } from './commands/sync.ts';
import { Imports } from './imports.ts';

if (process.platform !== 'darwin')
  throw new Error('The Apple connectors read apps on a Mac.');

const imports = new Imports([
  new MailApp(),
  new NotesApp(),
  new MessagesApp(),
  new ContactsApp(),
  new CalendarApp(),
  new RemindersApp(),
  new SafariApp(),
  new BooksApp(),
]);
const program = new Program('apple-cli')
  .description(
    'Import Apple apps on this Mac into outputs/cli, keep them current, and query them.',
  )
  .showHelpAfterError();
for (const command of [
  new SetupCommand(imports),
  new OptionsCommand(imports),
  new SyncCommand(imports),
  new StatusCommand(imports),
  new QueryCommand(imports),
])
  command.attach(program);
await program.parseAsync();
