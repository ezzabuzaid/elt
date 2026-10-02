import { BooksApp } from 'apple/apps/books';
import { CalendarApp } from 'apple/apps/calendar';
import { ContactsApp } from 'apple/apps/contacts';
import { MailApp } from 'apple/apps/mail';
import { MessagesApp } from 'apple/apps/messages';
import { NotesApp } from 'apple/apps/notes';
import { RemindersApp } from 'apple/apps/reminders';
import { SafariApp } from 'apple/apps/safari';
import { Command as Program } from 'commander';
import { OptionsCommand } from './commands/options.ts';
import { QueryCommand } from './commands/query.ts';
import { SetupCommand } from './commands/setup.ts';
import { StatusCommand } from './commands/status.ts';
import { SyncCommand } from './commands/sync.ts';
import { Imports } from './imports.ts';
import { TerminalHost } from './terminal-host.ts';

if (process.platform !== 'darwin')
  throw new Error('The Apple connectors read apps on a Mac.');

const host = new TerminalHost();
const imports = new Imports([
  new MailApp(host),
  new NotesApp(host),
  new MessagesApp(host),
  new ContactsApp(host),
  new CalendarApp(host),
  new RemindersApp(host),
  new SafariApp(host),
  new BooksApp(host),
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
