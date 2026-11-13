import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { Connection, Copy, Pipeline } from '@eltjs/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@eltjs/elt-postgresql';
import { AccountsStore, accountsStorePath } from '@eltjs/sdk-apple-accounts';
import { CalendarStore } from '@eltjs/sdk-apple-eventkit';
import { mailDirectory } from '@eltjs/sdk-apple-mail';
import { chatDatabasePath } from '@eltjs/sdk-apple-messages';
import { slackDesktopDirectory } from '@eltjs/sdk-slack-desktop';
import { whatsappContainer } from '@eltjs/sdk-whatsapp-desktop';
import { AppleCalendarSource } from '@eltjs/source-apple-calendar/apple-calendar-source';
import { AppleMailSource } from '@eltjs/source-apple-mail/apple-mail-source';
import { AppleMessagesSource } from '@eltjs/source-apple-messages/apple-messages-source';
import { SlackDesktopSource } from '@eltjs/source-slack-desktop/slack-desktop-source';
import { WhatsAppDesktopSource } from '@eltjs/source-whatsapp-desktop/whatsapp-desktop-source';

if (process.platform !== 'darwin')
  throw new Error(
    'proactive reads Calendar, Mail, Messages, Slack and WhatsApp on a Mac.',
  );

// The loading role, which owns the raw schemas, _warehouse and the marts.
export const warehouseUrl =
  'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';
const schema = 'apple_messages';

// Messages, every stream, loaded into its raw schema; readers see each stream
// as marts.messages_<stream>. macOS grants Full Disk Access, which chat.db
// needs, to the terminal that runs proactive.
const source = new AppleMessagesSource({
  path: chatDatabasePath(homedir()),
  home: homedir(),
});
const destination = new PostgresDestination({ url: warehouseUrl, schema });
const { streams } = await source.discover();
const slack = new SlackDesktopSource({
  directory: slackDesktopDirectory(homedir()),
});
const slackDestination = new PostgresDestination({
  url: warehouseUrl,
  schema: 'slack',
});
// WhatsApp's personal chats, with who the people in them are; readers see
// each stream as marts.whatsapp_<stream>.
const whatsapp = new WhatsAppDesktopSource({
  container: whatsappContainer(homedir()),
});
const whatsappDestination = new PostgresDestination({
  url: warehouseUrl,
  schema: 'whatsapp',
});
const calendarEnd = new Date();
calendarEnd.setUTCFullYear(calendarEnd.getUTCFullYear() + 1);
const calendar = new AppleCalendarSource({
  store: new CalendarStore(
    fileURLToPath(
      import.meta.resolve('@eltjs/sdk-apple-eventkit/eventkit-helper'),
    ),
    { env: process.env },
  ),
  startAt: new Date().toISOString(),
  endAt: calendarEnd.toISOString(),
});
const calendarDestination = new PostgresDestination({
  url: warehouseUrl,
  schema: 'apple_calendar',
});
const mail = new AppleMailSource({
  path: mailDirectory(homedir()),
  accounts: new AccountsStore(accountsStorePath(homedir())),
});
const mailDestination = new PostgresDestination({
  url: warehouseUrl,
  schema: 'apple_mail',
});

export default new Pipeline({
  clock: globalThis,
  history: new PostgresSyncHistory({ url: warehouseUrl }),
  connections: [
    new Connection({
      name: 'apple-messages',
      source,
      destination,
      checkpoints: new PostgresCheckpointStore({ url: warehouseUrl, schema }),
      steps: streams.map(
        (stream) =>
          new Copy(
            stream,
            destination
              .table(`raw_${stream.name}`)
              .withReaderView(
                'marts',
                `messages_${stream.name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
              ),
            {
              id: `messages:${stream.name}`,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            },
          ),
      ),
    }),
    new Connection({
      name: 'slack',
      source: slack,
      destination: slackDestination,
      checkpoints: new PostgresCheckpointStore({
        url: warehouseUrl,
        schema: 'slack',
      }),
      steps: [slack.messages, slack.threadReplies].map(
        (stream) =>
          new Copy(
            stream,
            slackDestination
              .table(`raw_${stream.name}`)
              .withReaderView(
                'marts',
                `slack_${stream.name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
              ),
            {
              id: `slack:${stream.name}`,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            },
          ),
      ),
    }),
    new Connection({
      name: 'whatsapp',
      source: whatsapp,
      destination: whatsappDestination,
      checkpoints: new PostgresCheckpointStore({
        url: warehouseUrl,
        schema: 'whatsapp',
      }),
      steps: [
        whatsapp.chats,
        whatsapp.messages,
        whatsapp.messageReactions,
        whatsapp.users,
        whatsapp.contacts,
        whatsapp.pushNames,
      ].map(
        (stream) =>
          new Copy(
            stream,
            whatsappDestination
              .table(`raw_${stream.name}`)
              .withReaderView(
                'marts',
                `whatsapp_${stream.name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
              ),
            {
              id: `whatsapp:${stream.name}`,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            },
          ),
      ),
    }),
    new Connection({
      name: 'apple-calendar',
      source: calendar,
      destination: calendarDestination,
      checkpoints: new PostgresCheckpointStore({
        url: warehouseUrl,
        schema: 'apple_calendar',
      }),
      steps: [calendar.calendars, calendar.events, calendar.attendees].map(
        (stream) =>
          new Copy(
            stream,
            calendarDestination
              .table(`raw_${stream.name}`)
              .withReaderView('marts', `calendar_${stream.name}`),
            {
              id: `calendar:${stream.name}`,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            },
          ),
      ),
    }),
    new Connection({
      name: 'apple-mail',
      source: mail,
      destination: mailDestination,
      checkpoints: new PostgresCheckpointStore({
        url: warehouseUrl,
        schema: 'apple_mail',
      }),
      steps: [
        mail.messages,
        mail.addresses,
        mail.subjects,
        mail.messageParts,
        mail.messageGlobalData,
        mail.conversationMessages,
      ].map(
        (stream) =>
          new Copy(
            stream,
            mailDestination
              .table(`raw_${stream.name}`)
              .withReaderView(
                'marts',
                `mail_${stream.name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
              ),
            {
              id: `mail:${stream.name}`,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            },
          ),
      ),
    }),
  ],
});
