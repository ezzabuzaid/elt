import type { KeyValue, RecordDraft } from '@workspace/elt';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const { id, accountId, nullableText } = teamsFields;

const properties = {
  accountId,
  meetingId: { ...id, description: 'The meeting (meetings.id).' },
  address: { ...id, description: 'The attendee’s email address.' },
  name: { ...nullableText, description: 'Their name.' },
  type: {
    ...nullableText,
    description: 'Required, Optional, Organizer or Resource.',
  },
  role: { ...nullableText, description: 'Their role, such as User.' },
  response: {
    ...nullableText,
    description: 'Their answer, such as Accepted, Tentative, Declined or None.',
  },
} as const;

type Row = RecordDraft<typeof properties>;

export class MeetingAttendeesStream extends TeamsStream<
  typeof properties,
  Row
> {
  readonly name = 'meetingAttendees';
  readonly primaryKey = ['accountId', 'meetingId', 'address'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per attendee of a meeting, for the meetings whose attendees the app holds. Primary key accountId, meetingId, address. An attendee removed from a meeting the app still holds is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  override covers(
    scan: TeamsScan,
    key: Readonly<Record<string, KeyValue>>,
  ): boolean {
    return scan.holdsMeeting(key.accountId, key.meetingId);
  }

  protected rows(scan: TeamsScan): readonly Row[] {
    return scan.clients.flatMap(({ account, meetings }) =>
      meetings.flatMap(({ id, attendees }) =>
        attendees.map((attendee) => ({
          accountId: account.userId,
          meetingId: id,
          ...attendee,
        })),
      ),
    );
  }

  protected records(row: Row): Row[] {
    return [row];
  }
}
