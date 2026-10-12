import type { RecordDraft } from '@workspace/elt';
import type { TeamsMeeting } from '@workspace/sdk-microsoft-teams';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const {
  id,
  accountId,
  instant,
  nullableText,
  nullableBoolean,
  nullablePreciseInstant,
} = teamsFields;

const properties = {
  accountId,
  id: { ...id, description: 'The calendar event’s ID in Exchange.' },
  iCalUid: {
    ...nullableText,
    description: 'Its iCalendar UID, shared by every occurrence of a series.',
  },
  seriesMasterId: {
    ...nullableText,
    description: 'For an occurrence, its series (meetings.id of the series).',
  },
  eventType: {
    ...nullableText,
    description:
      'Occurrence or Exception for a recurring meeting’s occurrence, as moved or changed.',
  },
  subject: { ...nullableText, description: 'Its title.' },
  startAt: { ...instant, description: 'When it starts.' },
  endAt: { ...instant, description: 'When it ends.' },
  timeZone: {
    ...nullableText,
    description: 'The time zone it was scheduled in, as Exchange names it.',
  },
  location: { ...nullableText, description: 'Where it takes place.' },
  organizerName: { ...nullableText, description: 'Who organizes it.' },
  organizerAddress: {
    ...nullableText,
    description: 'The organizer’s email address.',
  },
  isOnlineMeeting: {
    ...nullableBoolean,
    description: 'Whether it is a Teams meeting.',
  },
  joinUrl: { ...nullableText, description: 'The link to join it.' },
  conversationId: {
    ...nullableText,
    description: 'Its meeting chat (conversations.id).',
  },
  myResponse: {
    ...nullableText,
    description:
      'The user’s answer: Accepted, Tentative, Declined, NotResponded or Organizer.',
  },
  showAs: {
    ...nullableText,
    description: 'How it shows the user’s time: Busy, Tentative, Free….',
  },
  isCancelled: {
    type: 'boolean',
    description: 'Whether the organizer cancelled it.',
  },
  bodyPreview: {
    ...nullableText,
    description: 'The start of its invitation’s text.',
  },
  modifiedAt: {
    ...nullablePreciseInstant,
    description: 'When it was last changed.',
  },
} as const;

type Row = { readonly accountId: string; readonly meeting: TeamsMeeting };

export class MeetingsStream extends TeamsStream<typeof properties, Row> {
  readonly name = 'meetings';
  readonly primaryKey = ['accountId', 'id'];
  // The calendar keeps the meetings of a span around today that it does not
  // record, so a meeting gone from it may only have left the span; a
  // cancelled meeting says so in isCancelled.
  override readonly emitsDeletes = undefined;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per meeting on the account’s calendar that the app has held: it keeps the meetings of a few weeks around today. Primary key accountId, id. Every meeting held stays; a cancelled one says so in isCancelled.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: TeamsScan): readonly Row[] {
    return scan.clients.flatMap(({ account, meetings }) =>
      meetings.map((meeting) => ({ accountId: account.userId, meeting })),
    );
  }

  protected records({
    accountId,
    meeting: { attendees: _attendees, ...meeting },
  }: Row): RecordDraft<typeof properties>[] {
    return [{ accountId, ...meeting }];
  }
}
