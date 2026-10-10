import type { RecordDraft } from '@workspace/elt';
import type { AlarmDocument } from '@workspace/sdk-apple-eventkit';

import { type CalendarScan, location, timestamp } from '../calendar-scan.ts';
import {
  CalendarStream,
  calendarFields,
  locationFields,
  perOccurrence,
} from '../calendar-stream.ts';

const { id, eventId, ordinal, number, nullableTimestamp, nullableText } =
  calendarFields;

const properties = {
  id: {
    ...id,
    description: 'JSON [eventId, position]; unique within this stream.',
  },
  eventId,
  position: {
    ...ordinal,
    description:
      "Order among the owner's alarms in firing order: relative alarms by offset, then absolute alarms by date. EventKit's own order changes between reads, so it is not used.",
  },
  type: {
    ...ordinal,
    description:
      'EventKit EKAlarm.type raw value (EKAlarmType): 0 display, 1 audio, 2 procedure (opens a URL), 3 email. Unknown codes are kept as numbers.',
  },
  relativeOffset: {
    ...number,
    description:
      'EventKit EKAlarm.relativeOffset: seconds from the event start at which the alarm fires, negative before it. Apple documents an alarm as either relative or absolute, so it is not the trigger when absoluteAt is set.',
  },
  absoluteAt: {
    ...nullableTimestamp,
    description:
      'EventKit EKAlarm.absoluteDate as a UTC timestamp; NULL for a relative alarm.',
  },
  emailAddress: {
    ...nullableText,
    description:
      'EventKit EKAlarm.emailAddress, the recipient of an email alarm; NULL when unset.',
  },
  soundName: {
    ...nullableText,
    description:
      'EventKit EKAlarm.soundName, the system sound of an audio alarm; NULL when unset.',
  },
  proximity: {
    ...ordinal,
    description:
      'EventKit EKAlarm.proximity raw value (EKAlarmProximity): 0 none, 1 fires on entering, 2 on leaving the structured location. Unknown codes are kept as numbers.',
  },
  ...locationFields('EKAlarm.structuredLocation'),
} as const;

type Row = {
  readonly eventId: string;
  readonly position: number;
  readonly alarm: AlarmDocument;
};

export class AlarmsStream extends CalendarStream<typeof properties, Row> {
  readonly name = 'alarms';
  readonly jsonSchema = {
    type: 'object',
    description: `One source record per EventKit alarm of an event occurrence. ${perOccurrence} eventId refers to events.eventId. Relationships name source streams, not destination tables.`,
    properties,
    required: Object.keys(properties),
  } as const;

  // The store lists alarms in a stable order, so positions are stable.
  protected rows(scan: CalendarScan): readonly Row[] {
    return scan.events.flatMap(({ eventId, occurrence }) =>
      occurrence.alarms.map((alarm, position) => ({
        eventId,
        position,
        alarm,
      })),
    );
  }

  protected record({
    eventId,
    position,
    alarm,
  }: Row): RecordDraft<typeof properties> {
    return {
      id: JSON.stringify([eventId, position]),
      eventId,
      position,
      type: alarm.alarmType,
      relativeOffset: alarm.relativeOffset,
      absoluteAt: timestamp(alarm.absoluteMs),
      emailAddress: alarm.emailAddress ?? null,
      soundName: alarm.soundName ?? null,
      proximity: alarm.proximity,
      ...location(alarm.location),
    };
  }
}
