import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Copy, Pipeline, PipelineError, type Source } from 'elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
} from 'elt-sqlite';
import {
  GMAIL_READONLY_SCOPE,
  GOOGLE_DRIVE_READONLY_SCOPE,
  googleSession,
  grantDirectory,
} from 'google-auth';
import {
  AppleCalendarSource,
  AppleContactsSource,
  AppleMessagesSource,
  AppleNotesSource,
  AppleRemindersSource,
  CalendarIcsUnavailableError,
  CalendarUnavailableError,
  ContactsSchemaError,
  ContactsUnavailableError,
  EventKitChangingError,
  googleCalendarAttachments,
  MacOSDocumentParser,
  MessagesUnavailableError,
  NotesSchemaError,
  NotesUnavailableError,
  RemindersUnavailableError,
} from './index.ts';

type Connector = {
  name: string;
  source: Source;
  // Errors that mean this Mac cannot read the app right now: reported, and
  // the remaining connectors still load.
  unavailable: ReadonlyArray<new (...args: never[]) => Error>;
};

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
if (!clientId || !clientSecret)
  throw new Error(
    `Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to a Desktop-type OAuth client whose project has drive.googleapis.com and gmail.googleapis.com enabled; Calendar downloads attachments stored in Drive and Gmail. Grants are stored under ${grantDirectory()}.`,
  );
// The first run opens a browser for consent; later runs reuse the stored grant.
const google = await googleSession({
  clientId,
  clientSecret,
  scopes: [GOOGLE_DRIVE_READONLY_SCOPE, GMAIL_READONLY_SCOPE],
});

const out = resolve('outputs');
const year = 365 * 24 * 60 * 60 * 1000;

const connectors: Connector[] = [
  {
    name: 'notes',
    source: new AppleNotesSource(),
    unavailable: [NotesUnavailableError, NotesSchemaError],
  },
  {
    name: 'messages',
    source: new AppleMessagesSource(),
    unavailable: [MessagesUnavailableError],
  },
  {
    name: 'contacts',
    source: new AppleContactsSource(),
    unavailable: [ContactsUnavailableError, ContactsSchemaError],
  },
  {
    name: 'calendar',
    source: new AppleCalendarSource({
      // Before the earliest event on this Mac, through a year of upcoming ones.
      startAt: '2000-01-01T00:00:00.000Z',
      endAt: new Date(Date.now() + year).toISOString(),
      attachments: googleCalendarAttachments(google),
    }),
    unavailable: [
      CalendarUnavailableError,
      CalendarIcsUnavailableError,
      EventKitChangingError,
    ],
  },
  {
    name: 'reminders',
    source: new AppleRemindersSource(),
    unavailable: [RemindersUnavailableError, EventKitChangingError],
  },
];

// Loads every stream incrementally into <out>/apple-<name>.sqlite, with
// checkpoints in <out>/apple-<name>-state.sqlite. A stream with files also
// loads their text as `content` and their original bytes as `bytes`.
await mkdir(out, { recursive: true });
for (const { name, source, unavailable } of connectors) {
  const destination = new SQLiteDestination({
    path: join(out, `apple-${name}.sqlite`),
  });
  const { streams } = await source.discover();
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(out, `apple-${name}-state.sqlite`),
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
            id: `apple-${name}:${stream.name}`,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
            primaryKey: [...stream.primaryKey],
          },
        ),
    ),
  });
  // A stream that fails keeps its checkpoint while the others load, so the
  // run reports it and resumes it next time.
  const outcomes = await pipeline.run().then(
    (results) => results.map((result) => ({ ...result, failures: [] })),
    (error: unknown) => {
      if (error instanceof PipelineError) return error.results;
      if (!unavailable.some((type) => error instanceof type)) throw error;
      console.error(`${name}: ${(error as Error).message}`);
      return undefined;
    },
  );
  if (outcomes === undefined) {
    process.exitCode = 1;
    continue;
  }
  console.table(
    outcomes.map(({ copy, count, deleted, failures }) => ({
      stream: copy.from.name,
      table: copy.to.name,
      count,
      deleted,
      status: failures.length === 0 ? 'complete' : 'failed',
    })),
  );
  for (const { copy, failures } of outcomes)
    for (const { error } of failures) {
      console.error(
        `${name} ${copy.from.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
  console.log(`Loaded Apple ${name} into ${destination.path}`);
}
