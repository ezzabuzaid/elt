import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Copy, Pipeline, type Source } from 'elt';
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
import { MacOSDocumentParser } from './parsers/macos-document-parser.ts';
import { mailDirectory } from './platform/macos/mail-store.ts';
import { AppleCalendarSource } from './sources/apple-calendar/apple-calendar-source.ts';
import { googleCalendarAttachments } from './sources/apple-calendar/google-calendar-attachments.ts';
import { AppleContactsSource } from './sources/apple-contacts/apple-contacts-source.ts';
import { AppleMailSource } from './sources/apple-mail/apple-mail-source.ts';
import { AppleMessagesSource } from './sources/apple-messages/apple-messages-source.ts';
import { AppleNotesSource } from './sources/apple-notes/apple-notes-source.ts';
import { AppleRemindersSource } from './sources/apple-reminders/apple-reminders-source.ts';

const out = resolve('outputs');

// These sources all support snapshot incremental sync. Other connectors can
// register their own pipeline with different sync modes or destinations.
function apple(name: string, createSource: () => Source | Promise<Source>) {
  return {
    name: `apple-${name}`,
    async run() {
      const source = await createSource();
      await mkdir(out, { recursive: true });
      const destination = new SQLiteDestination({
        path: join(out, `apple-${name}.sqlite`),
      });
      const { streams } = await source.discover();
      await new Pipeline({
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
      }).run();
    },
  };
}

export default [
  apple('mail', () => new AppleMailSource(mailDirectory)),
  apple('notes', () => new AppleNotesSource()),
  apple('messages', () => new AppleMessagesSource()),
  apple('contacts', () => new AppleContactsSource()),
  apple('calendar', async () => {
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
    return new AppleCalendarSource({
      startAt: '2000-01-01T00:00:00.000Z',
      endAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      attachments: googleCalendarAttachments(google),
    });
  }),
  apple('reminders', () => new AppleRemindersSource()),
];
