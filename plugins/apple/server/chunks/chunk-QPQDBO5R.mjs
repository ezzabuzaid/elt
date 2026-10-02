import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  Catalog,
  Stream
} from "./chunk-PU5AI37R.mjs";

// apps/apple/connectors/dist/sources/eventkit-schema.js
var text = { type: "string" };
var id = { ...text, minLength: 1 };
var nullableText = { type: ["string", "null"] };
var integer = { type: "integer" };
var ordinal = { ...integer, minimum: 0 };
var boolean = { type: "boolean" };
var number = { type: "number" };
var timestamp = { ...text, format: "date-time" };
var nullableTimestamp = { ...nullableText, format: "date-time" };
var nullableDate = { ...nullableText, format: "date" };
var color = { type: ["number", "null"], minimum: 0, maximum: 1 };
var location = {
  locationTitle: nullableText,
  latitude: { type: ["number", "null"], minimum: -90, maximum: 90 },
  longitude: { type: ["number", "null"], minimum: -180, maximum: 180 },
  radius: { type: ["number", "null"], minimum: 0 }
};
var eventKitFields = {
  text,
  id,
  nullableText,
  integer,
  ordinal,
  boolean,
  number,
  timestamp,
  nullableTimestamp,
  nullableDate,
  location
};
var eventKitAccountFields = {
  id: {
    ...id,
    description: "EventKit EKSource.sourceIdentifier; accountId of the calendar or list stream within this source refers to it."
  },
  name: { ...text, description: "EventKit EKSource.title." },
  type: {
    ...ordinal,
    description: "EventKit EKSource.sourceType raw value (EKSourceType): 0 local, 1 Exchange, 2 CalDAV, 3 MobileMe, 4 subscribed, 5 birthdays. Unknown codes are kept as numbers."
  },
  isDelegate: {
    ...boolean,
    description: "EventKit EKSource.isDelegate: whether the account is delegated by another user."
  }
};
var eventKitCalendarFields = {
  id: {
    ...id,
    description: "EventKit EKCalendar.calendarIdentifier. Apple documents that a full sync can replace it, so it is not a stable identity."
  },
  accountId: {
    ...id,
    description: "EventKit EKCalendar.source.sourceIdentifier: the owning account; refers to accounts.id within this source."
  },
  name: { ...text, description: "EventKit EKCalendar.title." },
  type: {
    ...ordinal,
    description: "EventKit EKCalendar.type raw value (EKCalendarType): 0 local, 1 CalDAV, 2 Exchange, 3 subscription, 4 birthday. Apple reports a subscribed CalDAV calendar as 1 with subscribed true. Unknown codes are kept as numbers."
  },
  writable: {
    ...boolean,
    description: "EventKit EKCalendar.allowsContentModifications: whether items can be added, removed or modified in it."
  },
  subscribed: { ...boolean, description: "EventKit EKCalendar.isSubscribed." },
  immutable: {
    ...boolean,
    description: "EventKit EKCalendar.isImmutable: the calendar itself cannot be modified or deleted. It does not prevent adding items."
  },
  colorRed: {
    ...color,
    description: "Red component (0 to 1) of EventKit EKCalendar.color converted to sRGB; NULL when the calendar has no color."
  },
  colorGreen: {
    ...color,
    description: "Green component (0 to 1) of EventKit EKCalendar.color converted to sRGB; NULL when the calendar has no color."
  },
  colorBlue: {
    ...color,
    description: "Blue component (0 to 1) of EventKit EKCalendar.color converted to sRGB; NULL when the calendar has no color."
  },
  colorAlpha: {
    ...color,
    description: "Alpha component (0 to 1) of EventKit EKCalendar.color converted to sRGB; NULL when the calendar has no color."
  },
  supportedAvailabilities: {
    ...ordinal,
    description: "EventKit EKCalendar.supportedEventAvailabilities bitmask (EKCalendarEventAvailabilityMask): 1 busy, 2 free, 4 tentative, 8 unavailable; 0 when the calendar does not support event availability."
  },
  allowedEntityTypes: {
    ...ordinal,
    description: "EventKit EKCalendar.allowedEntityTypes bitmask (EKEntityMask): 1 events, 2 reminders."
  }
};
function eventKitLocationFields(property) {
  return {
    locationTitle: {
      ...location.locationTitle,
      description: `EventKit ${property}.title; NULL when there is no structured location or it has no title.`
    },
    latitude: {
      ...location.latitude,
      description: `Latitude in degrees of EventKit ${property}.geoLocation; NULL when there is no structured location or it has no coordinate.`
    },
    longitude: {
      ...location.longitude,
      description: `Longitude in degrees of EventKit ${property}.geoLocation; NULL when there is no structured location or it has no coordinate.`
    },
    radius: {
      ...location.radius,
      description: `EventKit ${property}.radius in meters; 0 means EventKit's default radius. NULL when there is no structured location.`
    }
  };
}
var owners = {
  eventId: {
    key: "Owning event occurrence; refers to events.eventId within this source.",
    kind: "'organizer' for EventKit EKEvent.organizer, always at position 0, or 'attendee' for an entry of EKCalendarItem.attendees.",
    relativeOffset: "EventKit EKAlarm.relativeOffset: seconds from the event start at which the alarm fires, negative before it. Apple documents an alarm as either relative or absolute, so it is not the trigger when absoluteAt is set."
  },
  reminderId: {
    key: "Owning reminder; refers to reminders.id within this source.",
    kind: "Always 'attendee': an entry of EventKit EKCalendarItem.attendees. Reminders read no organizer.",
    relativeOffset: "EventKit EKAlarm.relativeOffset in seconds. Apple documents it relative to an event start; which reminder date anchors it is not documented, so it is kept unconverted. Apple documents an alarm as either relative or absolute, so it is not the trigger when absoluteAt is set."
  }
};
function eventKitRelatedFields(ownerKey) {
  const owner = owners[ownerKey];
  return {
    attendees: {
      id: {
        ...id,
        description: `JSON [${ownerKey}, kind, position]; unique within this stream.`
      },
      [ownerKey]: { ...id, description: owner.key },
      position: {
        ...ordinal,
        description: "Order among the owner's participants of the same kind. Attendees are numbered in content order (URL, name, role, type), not EventKit's order, which changes between reads."
      },
      kind: { ...text, description: owner.kind },
      name: {
        ...nullableText,
        description: "EventKit EKParticipant.name; NULL when EventKit has none."
      },
      url: {
        ...nullableText,
        description: "EventKit EKParticipant.URL as a string."
      },
      status: {
        ...ordinal,
        description: "EventKit EKParticipant.participantStatus raw value (EKParticipantStatus): 0 unknown, 1 pending, 2 accepted, 3 declined, 4 tentative, 5 delegated, 6 completed, 7 in process. Unknown codes are kept as numbers."
      },
      role: {
        ...ordinal,
        description: "EventKit EKParticipant.participantRole raw value (EKParticipantRole): 0 unknown, 1 required, 2 optional, 3 chair, 4 non-participant. Unknown codes are kept as numbers."
      },
      type: {
        ...ordinal,
        description: "EventKit EKParticipant.participantType raw value (EKParticipantType): 0 unknown, 1 person, 2 room, 3 resource, 4 group. Unknown codes are kept as numbers."
      },
      isCurrentUser: {
        ...boolean,
        description: "EventKit EKParticipant.isCurrentUser: whether the participant is the owner of this account."
      }
    },
    alarms: {
      id: {
        ...id,
        description: `JSON [${ownerKey}, position]; unique within this stream.`
      },
      [ownerKey]: { ...id, description: owner.key },
      position: {
        ...ordinal,
        description: "Order among the owner's alarms, numbered in content order, not EventKit's order, which changes between reads."
      },
      type: {
        ...ordinal,
        description: "EventKit EKAlarm.type raw value (EKAlarmType): 0 display, 1 audio, 2 procedure (opens a URL), 3 email. Unknown codes are kept as numbers."
      },
      relativeOffset: { ...number, description: owner.relativeOffset },
      absoluteAt: {
        ...nullableTimestamp,
        description: "EventKit EKAlarm.absoluteDate as a UTC timestamp; NULL for a relative alarm."
      },
      emailAddress: {
        ...nullableText,
        description: "EventKit EKAlarm.emailAddress, the recipient of an email alarm; NULL when unset."
      },
      soundName: {
        ...nullableText,
        description: "EventKit EKAlarm.soundName, the system sound of an audio alarm; NULL when unset."
      },
      proximity: {
        ...ordinal,
        description: "EventKit EKAlarm.proximity raw value (EKAlarmProximity): 0 none, 1 fires on entering, 2 on leaving the structured location. Unknown codes are kept as numbers."
      },
      ...eventKitLocationFields("EKAlarm.structuredLocation")
    },
    recurrenceRules: {
      id: {
        ...id,
        description: `JSON [${ownerKey}, "recurrenceRule", position]; recurrenceRuleValues.ruleId refers to it.`
      },
      [ownerKey]: { ...id, description: owner.key },
      position: {
        ...ordinal,
        description: "Index in EventKit EKCalendarItem.recurrenceRules, in the order EventKit returns them."
      },
      calendarIdentifier: {
        ...text,
        description: "EventKit EKRecurrenceRule.calendarIdentifier: the calendar system the rule uses."
      },
      frequency: {
        ...ordinal,
        description: "EventKit EKRecurrenceRule.frequency raw value (EKRecurrenceFrequency): 0 daily, 1 weekly, 2 monthly, 3 yearly. Unknown codes are kept as numbers."
      },
      interval: {
        ...integer,
        minimum: 1,
        description: "EventKit EKRecurrenceRule.interval: the rule repeats every interval frequency units, such as 2 with weekly for every other week."
      },
      firstDayOfWeek: {
        ...integer,
        minimum: 0,
        maximum: 7,
        description: "EventKit EKRecurrenceRule.firstDayOfTheWeek: 1 Sunday through 7 Saturday; 0 when the rule does not set it."
      },
      endAt: {
        ...nullableTimestamp,
        description: "EventKit EKRecurrenceRule.recurrenceEnd.endDate as a UTC timestamp; NULL when the rule ends after a count or never ends."
      },
      occurrenceCount: {
        ...ordinal,
        description: "EventKit EKRecurrenceRule.recurrenceEnd.occurrenceCount; 0 when the rule ends at endAt or never ends. endAt NULL with 0 here means no end."
      }
    },
    recurrenceRuleValues: {
      id: {
        ...id,
        description: "JSON [ruleId, component, position]; unique within this stream."
      },
      [ownerKey]: { ...id, description: owner.key },
      ruleId: {
        ...id,
        description: "Owning rule; refers to recurrenceRules.id within this source."
      },
      component: {
        ...text,
        description: "The EventKit EKRecurrenceRule list property this value belongs to: daysOfTheWeek (iCalendar BYDAY), daysOfTheMonth (BYMONTHDAY), daysOfTheYear (BYYEARDAY), weeksOfTheYear (BYWEEKNO), monthsOfTheYear (BYMONTH) or setPositions (BYSETPOS)."
      },
      position: {
        ...ordinal,
        description: "Index in that EventKit list, in the order EventKit returns it."
      },
      value: {
        ...integer,
        description: "For daysOfTheWeek, EKRecurrenceDayOfWeek.dayOfTheWeek (EKWeekday): 1 Sunday through 7 Saturday. Otherwise the list entry; negative values count from the end of the month or year (setPositions: from the end of the set)."
      },
      weekNumber: {
        type: ["integer", "null"],
        description: "For daysOfTheWeek, EventKit EKRecurrenceDayOfWeek.weekNumber, which Apple's plain dayOfWeek: constructor sets to 0; NULL for every other component."
      }
    }
  };
}
function eventKitCatalog(streams, { snapshot = false, fileTransfer = [] } = {}) {
  return new Catalog(Object.entries(streams).map(([name, { description, properties }]) => new Stream({
    name,
    jsonSchema: {
      type: "object",
      description,
      properties,
      required: Object.keys(properties)
    },
    primaryKey: ["id"],
    supportedSyncModes: snapshot ? ["full_refresh", "incremental"] : ["full_refresh"],
    ...snapshot && {
      sourceDefinedCursor: true,
      emitsDeletes: true
    },
    ...fileTransfer.includes(name) && { supportsFileTransfer: true }
  })));
}

export {
  eventKitFields,
  eventKitAccountFields,
  eventKitCalendarFields,
  eventKitLocationFields,
  eventKitRelatedFields,
  eventKitCatalog
};
