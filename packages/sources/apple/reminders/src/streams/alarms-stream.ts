import type { RecordDraft } from '@workspace/elt';
import type {
  AlarmDocument,
  LocationDocument,
} from '@workspace/macos-eventkit';

import {
  AppleRemindersStream,
  remindersFields,
} from '../apple-reminders-stream.ts';
import { type RemindersScan, timestamp } from '../reminders-scan.ts';

const {
  id,
  nullableText,
  ordinal,
  number,
  nullableTimestamp,
  location,
  reminderId,
} = remindersFields;

// An EKStructuredLocation, flattened; property names the EventKit property
// that holds it.
function locationFields(property: string) {
  return {
    locationTitle: {
      ...location.locationTitle,
      description: `EventKit ${property}.title; NULL when there is no structured location or it has no title.`,
    },
    latitude: {
      ...location.latitude,
      description: `Latitude in degrees of EventKit ${property}.geoLocation; NULL when there is no structured location or it has no coordinate.`,
    },
    longitude: {
      ...location.longitude,
      description: `Longitude in degrees of EventKit ${property}.geoLocation; NULL when there is no structured location or it has no coordinate.`,
    },
    radius: {
      ...location.radius,
      description: `EventKit ${property}.radius in meters; 0 means EventKit's default radius. NULL when there is no structured location.`,
    },
  };
}

function place(structured: LocationDocument | undefined) {
  return {
    locationTitle: structured?.title ?? null,
    latitude: structured?.latitude ?? null,
    longitude: structured?.longitude ?? null,
    radius: structured?.radius ?? null,
  };
}

// The store lists alarms in a stable order, so positions are stable.
type AlarmRow = {
  readonly reminderId: string;
  readonly alarm: AlarmDocument;
  readonly position: number;
};

const properties = {
  id: {
    ...id,
    description: 'JSON [reminderId, position]; unique within this stream.',
  },
  reminderId,
  position: {
    ...ordinal,
    description:
      "Order among the owner's alarms, numbered in content order, not EventKit's order, which changes between reads.",
  },
  type: {
    ...ordinal,
    description:
      'EventKit EKAlarm.type raw value (EKAlarmType): 0 display, 1 audio, 2 procedure (opens a URL), 3 email. Unknown codes are kept as numbers.',
  },
  relativeOffset: {
    ...number,
    description:
      'EventKit EKAlarm.relativeOffset in seconds. Apple documents it relative to an event start; which reminder date anchors it is not documented, so it is kept unconverted. Apple documents an alarm as either relative or absolute, so it is not the trigger when absoluteAt is set.',
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

export class AlarmsStream extends AppleRemindersStream<
  typeof properties,
  AlarmRow
> {
  readonly name = 'alarms';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per EventKit alarm of a reminder, whether it fires at a time or at a location. reminderId refers to reminders.id. Relationships name source streams, not destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: RemindersScan): readonly AlarmRow[] {
    return scan.reminders.flatMap((reminder) =>
      reminder.alarms.map((alarm, position) => ({
        reminderId: reminder.id,
        alarm,
        position,
      })),
    );
  }

  protected record({
    reminderId,
    alarm,
    position,
  }: AlarmRow): RecordDraft<typeof properties> {
    return {
      id: JSON.stringify([reminderId, position]),
      reminderId,
      position,
      type: alarm.alarmType,
      relativeOffset: alarm.relativeOffset,
      absoluteAt: timestamp(alarm.absoluteMs),
      emailAddress: alarm.emailAddress ?? null,
      soundName: alarm.soundName ?? null,
      proximity: alarm.proximity,
      ...place(alarm.location),
    };
  }
}
