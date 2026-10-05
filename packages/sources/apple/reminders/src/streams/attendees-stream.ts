import type { RecordDraft } from '@workspace/elt';
import type { ParticipantDocument } from '@workspace/sdk-apple-eventkit';

import {
  AppleRemindersStream,
  remindersFields,
} from '../apple-reminders-stream.ts';
import type { RemindersScan } from '../reminders-scan.ts';

const { id, text, ordinal, nullableText, boolean, reminderId } =
  remindersFields;

// The store lists attendees in a stable order, so positions are stable.
type AttendeeRow = {
  readonly reminderId: string;
  readonly attendee: ParticipantDocument;
  readonly position: number;
};

const properties = {
  id: {
    ...id,
    description:
      'JSON [reminderId, kind, position]; unique within this stream.',
  },
  reminderId,
  position: {
    ...ordinal,
    description:
      "Order among the owner's participants of the same kind. Attendees are numbered in content order (URL, name, role, type), not EventKit's order, which changes between reads.",
  },
  kind: {
    ...text,
    description:
      "Always 'attendee': an entry of EventKit EKCalendarItem.attendees. Reminders read no organizer.",
  },
  name: {
    ...nullableText,
    description: 'EventKit EKParticipant.name; NULL when EventKit has none.',
  },
  url: {
    ...nullableText,
    description: 'EventKit EKParticipant.URL as a string.',
  },
  status: {
    ...ordinal,
    description:
      'EventKit EKParticipant.participantStatus raw value (EKParticipantStatus): 0 unknown, 1 pending, 2 accepted, 3 declined, 4 tentative, 5 delegated, 6 completed, 7 in process. Unknown codes are kept as numbers.',
  },
  role: {
    ...ordinal,
    description:
      'EventKit EKParticipant.participantRole raw value (EKParticipantRole): 0 unknown, 1 required, 2 optional, 3 chair, 4 non-participant. Unknown codes are kept as numbers.',
  },
  type: {
    ...ordinal,
    description:
      'EventKit EKParticipant.participantType raw value (EKParticipantType): 0 unknown, 1 person, 2 room, 3 resource, 4 group. Unknown codes are kept as numbers.',
  },
  isCurrentUser: {
    ...boolean,
    description:
      'EventKit EKParticipant.isCurrentUser: whether the participant is the owner of this account.',
  },
} as const;

export class AttendeesStream extends AppleRemindersStream<
  typeof properties,
  AttendeeRow
> {
  readonly name = 'attendees';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per attendee EventKit lists for a reminder. reminderId refers to reminders.id. Relationships name source streams, not destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: RemindersScan): readonly AttendeeRow[] {
    return scan.reminders.flatMap((reminder) =>
      reminder.attendees.map((attendee, position) => ({
        reminderId: reminder.id,
        attendee,
        position,
      })),
    );
  }

  protected record({
    reminderId,
    attendee,
    position,
  }: AttendeeRow): RecordDraft<typeof properties> {
    return {
      id: JSON.stringify([reminderId, 'attendee', position]),
      reminderId,
      position,
      kind: 'attendee',
      name: attendee.name ?? null,
      url: attendee.url,
      status: attendee.status,
      role: attendee.role,
      type: attendee.participantType,
      isCurrentUser: attendee.isCurrentUser,
    };
  }
}
