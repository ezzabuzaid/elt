import { Command as Program } from 'commander';
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
import { Store } from './store.ts';

if (process.platform !== 'darwin')
  throw new Error('The Apple connectors read apps on a Mac.');

const apps = [
  new MailApp(),
  new NotesApp(),
  new MessagesApp(),
  new ContactsApp(),
  new CalendarApp(),
  new RemindersApp(),
  new SafariApp(),
];
const store = new Store();
const sync = new SyncCommand(apps, store);
const program = new Program('cli')
  .description(
    'Import Apple apps on this Mac into outputs/cli, keep them current, and query them.',
  )
  .showHelpAfterError();
for (const command of [
  new SetupCommand(apps, store, sync),
  new OptionsCommand(apps),
  sync,
  new StatusCommand(apps, store),
  new QueryCommand(apps, store),
])
  command.attach(program);
await program.parseAsync();
