import type { VanishedRecord } from '@zukhruf/snapshot-differential';

import type { RecordDraft } from '@eltjs/elt';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const { id, accountId, position, nullableText } = teamsFields;

const properties = {
  accountId,
  meetingId: { ...id, description: 'The meeting (meetings.id).' },
  position: {
    ...position,
    description: 'The attendee’s place in the meeting’s list, from 0.',
  },
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
  readonly primaryKey = ['accountId', 'meetingId', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per place in the list of attendees of a meeting, for the meetings whose attendees the app holds. Primary key accountId, meetingId, position. An attendee removed from a meeting the app still holds is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  override covers(scan: TeamsScan, { key }: VanishedRecord): boolean {
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
