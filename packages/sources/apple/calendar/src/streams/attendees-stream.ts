import type { RecordDraft } from '@workspace/elt';
import type { ParticipantDocument } from '@workspace/macos-eventkit';

import type { CalendarScan } from '../calendar-scan.ts';
import {
  CalendarStream,
  calendarFields,
  perOccurrence,
} from '../calendar-stream.ts';

const { id, eventId, ordinal, text, nullableText, boolean } = calendarFields;

const properties = {
  id: {
    ...id,
    description: 'JSON [eventId, kind, position]; unique within this stream.',
  },
  eventId,
  position: {
    ...ordinal,
    description:
      "Order among the owner's participants of the same kind. Attendees are numbered in content order (URL, name, role, type), not EventKit's order, which changes between reads.",
  },
  kind: {
    ...text,
    description:
      "'organizer' for EventKit EKEvent.organizer, always at position 0, or 'attendee' for an entry of EKCalendarItem.attendees.",
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

type Row = {
  readonly eventId: string;
  readonly kind: 'organizer' | 'attendee';
  readonly position: number;
  readonly participant: ParticipantDocument;
};

export class AttendeesStream extends CalendarStream<typeof properties, Row> {
  readonly name = 'attendees';
  readonly jsonSchema = {
    type: 'object',
    description: `One source record per participant of an event occurrence: its organizer and each attendee. ${perOccurrence} eventId refers to events.eventId. Relationships name source streams, not destination tables.`,
    properties,
    required: Object.keys(properties),
  } as const;

  // The store lists attendees in a stable order, so positions are stable.
  protected rows(scan: CalendarScan): readonly Row[] {
    return scan.events.flatMap(({ eventId, occurrence }) => [
      ...(occurrence.organizer === undefined
        ? []
        : [
            {
              eventId,
              kind: 'organizer' as const,
              position: 0,
              participant: occurrence.organizer,
            },
          ]),
      ...occurrence.attendees.map((participant, position) => ({
        eventId,
        kind: 'attendee' as const,
        position,
        participant,
      })),
    ]);
  }

  protected record({
    eventId,
    kind,
    position,
    participant,
  }: Row): RecordDraft<typeof properties> {
    return {
      id: JSON.stringify([eventId, kind, position]),
      eventId,
      position,
      kind,
      name: participant.name ?? null,
      url: participant.url,
      status: participant.status,
      role: participant.role,
      type: participant.participantType,
      isCurrentUser: participant.isCurrentUser,
    };
  }
}
