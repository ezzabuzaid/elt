import { join, resolve } from 'node:path';
import { Connection, Copy, LocalFiles, Pipeline, type Source } from 'elt';
import {
  PostgresCheckpointStore,
  PostgresColumns,
  PostgresDestination,
  PostgresSyncHistory,
} from 'elt-postgresql';
import {
  GMAIL_READONLY_SCOPE,
  GOOGLE_DRIVE_READONLY_SCOPE,
  googleSession,
  grantDirectory,
} from 'google-auth';
import { MacOSDocumentParser } from './parsers/macos-document-parser.ts';
import { mailDirectory } from './platform/macos/mail-store.ts';
import { AppleCalendarSource } from './sources/apple-calendar/apple-calendar-source.ts';
import { googleCalendarAttachments } from './sources/apple-calendar/google-calendar-attachments.ts';
import { AppleContactsSource } from './sources/apple-contacts/apple-contacts-source.ts';
import { AppleMailSource } from './sources/apple-mail/apple-mail-source.ts';
import { AppleMessagesSource } from './sources/apple-messages/apple-messages-source.ts';
import { AppleNotesSource } from './sources/apple-notes/apple-notes-source.ts';
import { AppleRemindersSource } from './sources/apple-reminders/apple-reminders-source.ts';

const warehouseUrl = 'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';

// Every stream of one Apple source, loaded incrementally into its own schema
// beside its checkpoints.
async function apple(name: string, source: Source) {
  const schema = `apple_${name}`;
  const destination = new PostgresDestination({ url: warehouseUrl, schema });
  const files = new LocalFiles({
    directory: join(resolve('outputs'), `apple-${name}-files`),
  });
  const { streams } = await source.discover();
  return new Connection({
    name: `apple-${name}`,
    source,
    destination,
    checkpoints: new PostgresCheckpointStore({ url: warehouseUrl, schema }),
    steps: streams.map(
      (stream) =>
        new Copy(
          stream,
          stream.supportsFileTransfer
            ? destination.table(`raw_${stream.name}`, (columns) => [
                ...PostgresColumns.fromSchema(stream.jsonSchema),
                columns
                  .text('content')
                  .from(stream.file)
                  .parse(new MacOSDocumentParser()),
                columns.text('attachmentRef').from(stream.file.store(files)),
              ])
            : destination.table(`raw_${stream.name}`),
          {
            id: `apple-${name}:${stream.name}`,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          },
        ),
    ),
  });
}

// Calendar downloads attachments stored in Google Drive and Gmail.
const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
if (!clientId || !clientSecret)
  throw new Error(
    `Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET for Calendar's Drive/Gmail attachments; grants are stored under ${grantDirectory()}.`,
  );
const google = await googleSession({
  clientId,
  clientSecret,
  scopes: [GOOGLE_DRIVE_READONLY_SCOPE, GMAIL_READONLY_SCOPE],
});

export const history = new PostgresSyncHistory({ url: warehouseUrl });

export default new Pipeline({
  history,
  connections: [
    await apple('mail', new AppleMailSource(mailDirectory)),
    await apple('notes', new AppleNotesSource()),
    await apple('messages', new AppleMessagesSource()),
    await apple('contacts', new AppleContactsSource()),
    await apple(
      'calendar',
      new AppleCalendarSource({
        startAt: '2000-01-01T00:00:00.000Z',
        endAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        attachments: googleCalendarAttachments(google),
      }),
    ),
    await apple('reminders', new AppleRemindersSource()),
  ],
});
