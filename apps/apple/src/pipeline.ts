import { resolve } from 'node:path';
import { Pipeline, type Source } from 'elt';
import { PostgresSyncHistory } from 'elt-postgresql';
import {
  GMAIL_READONLY_SCOPE,
  GOOGLE_DRIVE_READONLY_SCOPE,
  googleSession,
  grantDirectory,
} from 'google-auth';
import { mailDirectory } from './platform/macos/mail-store.ts';
import { AppleBooksSource } from './sources/apple-books/apple-books-source.ts';
import { AppleCalendarSource } from './sources/apple-calendar/apple-calendar-source.ts';
import { googleCalendarAttachments } from './sources/apple-calendar/google-calendar-attachments.ts';
import { AppleContactsSource } from './sources/apple-contacts/apple-contacts-source.ts';
import { AppleMailSource } from './sources/apple-mail/apple-mail-source.ts';
import { AppleMessagesSource } from './sources/apple-messages/apple-messages-source.ts';
import { AppleNotesSource } from './sources/apple-notes/apple-notes-source.ts';
import { AppleRemindersSource } from './sources/apple-reminders/apple-reminders-source.ts';
import { AppleSafariSource } from './sources/apple-safari/apple-safari-source.ts';
import { warehouseConnection } from './warehouse-connection.ts';

export const warehouseUrl =
  'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';
const apple = (name: string, source: Source) =>
  warehouseConnection(name, source, {
    url: warehouseUrl,
    outputs: resolve('outputs'),
  });

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
    await apple('safari', new AppleSafariSource()),
    await apple('books', new AppleBooksSource()),
  ],
});
