import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  CalendarStore,
  IcsExportUnavailableError
} from "../../chunks/chunk-R6L4WQ3V.mjs";
import {
  accounts,
  collections,
  name
} from "../../chunks/chunk-WAJDD7QK.mjs";
import {
  eventKitFields
} from "../../chunks/chunk-YUEL2AIL.mjs";
import {
  AppleApp
} from "../../chunks/chunk-DZDPSHJB.mjs";
import {
  Catalog,
  Source,
  Stream,
  diffSnapshot,
  isTimestamp,
  validateRecords
} from "../../chunks/chunk-OEQ4WCEQ.mjs";
import {
  __callDispose,
  __using
} from "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/google-auth/dist/scopes.js
var GOOGLE_DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
var GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

// packages/sources/apple/calendar/dist/apple-calendar-source.js
import { lstat, mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

// packages/sources/apple/calendar/dist/calendar-fields.js
var { text, id, nullableText, integer, ordinal, boolean, number, nullableTimestamp, location } = eventKitFields;
var color = { type: ["number", "null"], minimum: 0, maximum: 1 };
var eventId = {
  ...id,
  description: "Owning event occurrence; refers to events.eventId within this source."
};
var accountFields = {
  id: {
    ...id,
    description: "EventKit EKSource.sourceIdentifier; accountId of the calendars stream within this source refers to it."
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
var calendarFields = {
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
  },
  description: {
    ...text,
    description: "Calendar.app's calendar description, read from EKCalendar's private notes property; empty when the calendar has none."
  }
};
function locationFields(property) {
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
var attendeeFields = {
  id: {
    ...id,
    description: "JSON [eventId, kind, position]; unique within this stream."
  },
  eventId,
  position: {
    ...ordinal,
    description: "Order among the owner's participants of the same kind. Attendees are numbered in content order (URL, name, role, type), not EventKit's order, which changes between reads."
  },
  kind: {
    ...text,
    description: "'organizer' for EventKit EKEvent.organizer, always at position 0, or 'attendee' for an entry of EKCalendarItem.attendees."
  },
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
};
var alarmFields = {
  id: {
    ...id,
    description: "JSON [eventId, position]; unique within this stream."
  },
  eventId,
  position: {
    ...ordinal,
    description: "Order among the owner's alarms, numbered in content order, not EventKit's order, which changes between reads."
  },
  type: {
    ...ordinal,
    description: "EventKit EKAlarm.type raw value (EKAlarmType): 0 display, 1 audio, 2 procedure (opens a URL), 3 email. Unknown codes are kept as numbers."
  },
  relativeOffset: {
    ...number,
    description: "EventKit EKAlarm.relativeOffset: seconds from the event start at which the alarm fires, negative before it. Apple documents an alarm as either relative or absolute, so it is not the trigger when absoluteAt is set."
  },
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
  ...locationFields("EKAlarm.structuredLocation")
};
var recurrenceRuleFields = {
  id: {
    ...id,
    description: 'JSON [eventId, "recurrenceRule", position]; recurrenceRuleValues.ruleId refers to it.'
  },
  eventId,
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
};
var recurrenceRuleValueFields = {
  id: {
    ...id,
    description: "JSON [ruleId, component, position]; unique within this stream."
  },
  eventId,
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
};

// packages/sources/apple/calendar/dist/calendar-catalog.js
var { id: id2, text: text2, nullableText: nullableText2, timestamp, nullableTimestamp: nullableTimestamp2, nullableDate, boolean: boolean2, ordinal: ordinal2, integer: integer2 } = eventKitFields;
var perOccurrence = "Rows belong to an occurrence, not a series: each selected occurrence of a recurring series repeats them, so counts across a series multiply.";
var icsItem = {
  calendarId: {
    ...id2,
    description: "EventKit calendar identifier of the exported item; refers to calendars.id within this source."
  },
  calendarItemId: {
    ...id2,
    description: "EventKit EKCalendarItem.calendarItemIdentifier of the exported item. With calendarId it matches events of every occurrence of that item."
  }
};
var streams = {
  accounts: {
    description: "One source record per EventKit account (EKSource) in this Mac's event store, including accounts without event calendars. No date filter: the event window does not restrict it. An import scope keeps the selected accounts; a calendar scope also drops accounts owning no selected calendar. Relationships name source streams, not destination tables.",
    properties: accountFields
  },
  calendars: {
    description: "One source record per event calendar visible through EventKit on this Mac. No date filter: the event window does not restrict it. An import scope keeps only the selected calendars. accountId refers to accounts.id; events and ICS rows refer to id through calendarId. Relationships name source streams, not destination tables.",
    properties: calendarFields
  },
  events: {
    description: "One source record per event occurrence, not per series: a recurring event yields one record for each occurrence overlapping the configured UTC interval [startAt, endAt); a zero-duration event must start inside it. Key id equals eventId, JSON [calendarId, calendarItemId, occurrenceKey]; never substitute nativeEventId or startAt for it. attendees, alarms, recurrenceRules and recurrenceRuleValues join on eventId. ICS rows describe the whole native item at (calendarId, calendarItemId) and can cover occurrences outside the interval; only a nonrecurring VEVENT carries eventId. startAt and endAt are UTC instants; startDate and endDate are local calendar dates, set for all-day events only. Only calendars visible on this Mac within the import scope are read. Relationships name source streams, not destination tables.",
    properties: {
      id: { ...id2, description: "Same value as eventId; the record key." },
      eventId: {
        ...id2,
        description: "Occurrence identity: JSON [calendarId, calendarItemId, occurrenceKey]. occurrenceKey is NULL for a nonrecurring event, occurrenceDate for a recurring all-day event and occurrenceAt for a recurring timed event, so moving an occurrence keeps its identity. An event is recurring when it has recurrence rules or is detached. Related EventKit rows join here."
      },
      calendarId: {
        ...id2,
        description: "EventKit EKCalendarItem.calendar.calendarIdentifier; refers to calendars.id within this source."
      },
      calendarItemId: {
        ...id2,
        description: "EventKit EKCalendarItem.calendarItemIdentifier of the native item; every occurrence of a recurring series shares it. ICS rows relate on (calendarId, calendarItemId). Apple documents that a full sync can replace it."
      },
      externalId: {
        ...nullableText2,
        description: "EventKit EKCalendarItem.calendarItemExternalIdentifier, the server-provided identifier shared by every occurrence of a series; NULL when EventKit has none. Apple documents duplicates across calendars (imports, shared or delegated calendars), so it is not unique."
      },
      nativeEventId: {
        ...nullableText2,
        description: "EventKit EKEvent.eventIdentifier; NULL when EventKit has none. Apple documents that it can change when the event moves calendar or syncs; it is not the occurrence identity."
      },
      name: { ...text2, description: "EventKit EKCalendarItem.title." },
      body: {
        ...nullableText2,
        description: "EventKit EKCalendarItem.notes; NULL when unset."
      },
      location: {
        ...nullableText2,
        description: "EventKit EKCalendarItem.location; NULL when unset."
      },
      url: {
        ...nullableText2,
        description: "EventKit EKCalendarItem.URL as a string; NULL when unset."
      },
      startAt: {
        ...timestamp,
        description: "EventKit EKEvent.startDate as a UTC timestamp. Apple returns a floating event, such as an all-day event, in the default time zone of the process that read it; use startDate for all-day days."
      },
      endAt: {
        ...timestamp,
        description: "EventKit EKEvent.endDate as a UTC timestamp; never before startAt. Floating events use the reading process time zone, as startAt does."
      },
      allDay: { ...boolean2, description: "EventKit EKEvent.isAllDay." },
      startDate: {
        ...nullableDate,
        description: "For an all-day event, the local calendar date of EventKit EKEvent.startDate in the default time zone of the process that read it, as Calendar shows it; NULL for a timed event."
      },
      endDate: {
        ...nullableDate,
        description: "For an all-day event, the local calendar date of EventKit EKEvent.endDate in the default time zone of the process that read it, not adjusted to an inclusive or exclusive end; NULL for a timed event."
      },
      timeZone: {
        ...nullableText2,
        description: "EventKit EKCalendarItem.timeZone identifier; NULL for a floating event, which Apple documents as occurring at the same wall-clock time in every time zone."
      },
      createdAt: {
        ...nullableTimestamp2,
        description: "EventKit EKCalendarItem.creationDate as a UTC timestamp; NULL when EventKit has none."
      },
      modifiedAt: {
        ...nullableTimestamp2,
        description: "EventKit EKCalendarItem.lastModifiedDate as a UTC timestamp; NULL when EventKit has none."
      },
      occurrenceAt: {
        ...nullableTimestamp2,
        description: "EventKit EKEvent.occurrenceDate as a UTC timestamp: when this occurrence was originally scheduled, unchanged when it is detached and moved. NULL for a nonrecurring event."
      },
      occurrenceDate: {
        ...nullableDate,
        description: "Local calendar date of EventKit EKEvent.occurrenceDate in the default time zone of the process that read it, set only for a recurring all-day event; NULL otherwise."
      },
      detached: {
        ...boolean2,
        description: "EventKit EKEvent.isDetached: an occurrence of a recurring series changed from what the series generates."
      },
      status: {
        ...ordinal2,
        description: "EventKit EKEvent.status raw value (EKEventStatus): 0 none, 1 confirmed, 2 tentative, 3 canceled. Apple documents only canceled as reliable. Unknown codes are kept as numbers."
      },
      availability: {
        ...integer2,
        description: "EventKit EKEvent.availability raw value (EKEventAvailability): -1 not supported by the calendar, 0 busy, 1 free, 2 tentative, 3 unavailable. Unknown codes are kept as numbers."
      },
      birthdayContactId: {
        ...nullableText2,
        description: "EventKit EKEvent.birthdayContactIdentifier, a Contacts framework contact identifier set only for events of the Birthdays calendar; NULL otherwise. Not verified to match identifiers of the Apple Contacts source."
      },
      ...locationFields("EKEvent.structuredLocation")
    }
  },
  icsComponents: {
    description: "One source record per iCalendar component in the private EventKit ICS export of each native item with an occurrence in the event window: the VCALENDAR root, the VEVENT master, exception VEVENTs carrying RECURRENCE-ID, their alarms and any other exported component. Each item is exported once and whole, so a recurring series can describe occurrences outside the window. Grain is the native item (calendarId, calendarItemId), not an occurrence: eventId is set only for a nonrecurring VEVENT. Joining recurring components to events on (calendarId, calendarItemId) repeats them once per occurrence, so aggregate occurrences before joining. The ICS streams are read only when one is selected; on a macOS without the private export the read fails instead of loading no rows. Relationships name source streams, not destination tables.",
    properties: {
      id: {
        ...id2,
        description: 'JSON [calendarId, calendarItemId, path], where path lists child positions from the root VCALENDAR ("0", "0.1", \u2026).'
      },
      ...icsItem,
      parentId: {
        ...nullableText2,
        description: "Enclosing component; refers to icsComponents.id within this source. NULL for the root VCALENDAR."
      },
      position: {
        ...ordinal2,
        description: "Order among sibling components, numbered in content order: EventKit's export order changes between reads."
      },
      name: {
        ...text2,
        description: "Component name as exported, uppercased, such as VCALENDAR, VEVENT or VALARM."
      },
      uid: {
        ...nullableText2,
        description: "Raw value of the component's UID property; NULL when it has none."
      },
      recurrenceId: {
        ...nullableText2,
        description: "Raw, unparsed value of the component's RECURRENCE-ID property, which marks a component overriding one occurrence of a series; NULL when absent."
      },
      recurrenceIdTimeZone: {
        ...nullableText2,
        description: "First TZID parameter value of RECURRENCE-ID; NULL when RECURRENCE-ID is absent or has no TZID."
      },
      eventId: {
        ...nullableText2,
        description: "events.eventId of the nonrecurring event this VEVENT exactly describes: set only for a VEVENT without RECURRENCE-ID of an item that has no recurrence rules and is not detached. NULL for every other component, including all components of a recurring item, which relate at (calendarId, calendarItemId)."
      }
    }
  },
  icsProperties: {
    description: "One source record per property line of an icsComponents component, in export order, except DTSTAMP: EventKit sets it to the export time, so it is omitted. Values are raw iCalendar text; vendor X- properties are kept. ATTACH properties also appear in icsAttachments. Relationships name source streams, not destination tables.",
    properties: {
      id: {
        ...id2,
        description: "JSON [calendarId, calendarItemId, path, position], extending the component path; icsParameters.propertyId and icsAttachments.propertyId refer to it."
      },
      componentId: {
        ...id2,
        description: "Owning component; refers to icsComponents.id within this source."
      },
      ...icsItem,
      position: {
        ...ordinal2,
        description: "Index among the component's properties in export order, counted after DTSTAMP is removed."
      },
      name: {
        ...text2,
        description: "Property name as exported, uppercased, including vendor X- names."
      },
      value: {
        ...text2,
        description: "Raw property value as exported after line unfolding: no TEXT unescaping, date parsing or decoding. An inline ATTACH value is a whole base64 file."
      }
    }
  },
  icsAttachments: {
    description: "One source record per ATTACH property in the ICS export; the same property also remains in icsProperties with its parameters in icsParameters. File bytes can be inline (base64 in uri), remote (retrieved only by the attachment fetcher the app supplies) or unavailable: an attachment record exists even when no bytes are exported. Relationships name source streams, not destination tables.",
    properties: {
      id: {
        ...id2,
        description: "Same value as propertyId; the record key."
      },
      propertyId: {
        ...id2,
        description: "The ATTACH property; refers to icsProperties.id within this source."
      },
      componentId: {
        ...id2,
        description: "Component holding the ATTACH property; refers to icsComponents.id within this source."
      },
      ...icsItem,
      uri: {
        ...text2,
        description: "Raw ATTACH value: the base64 file content when inline is true, otherwise the attachment URI."
      },
      filename: {
        ...nullableText2,
        description: "First value of the ATTACH X-APPLE-FILENAME parameter, else of FILENAME; NULL when neither is present."
      },
      formatType: {
        ...nullableText2,
        description: "First value of the ATTACH FMTTYPE parameter, a media type; NULL when absent."
      },
      inline: {
        ...boolean2,
        description: "Whether ATTACH carries VALUE=BINARY or ENCODING=BASE64, so uri holds the file content itself rather than a location."
      }
    }
  },
  icsParameters: {
    description: "One source record per value of each iCalendar property parameter: a comma-separated multi-value parameter yields one record per value. Relationships name source streams, not destination tables.",
    properties: {
      id: {
        ...id2,
        description: "JSON [calendarId, calendarItemId, path, propertyPosition, position, valuePosition], extending the property id."
      },
      propertyId: {
        ...id2,
        description: "Owning property; refers to icsProperties.id within this source."
      },
      componentId: {
        ...id2,
        description: "Component of the owning property; refers to icsComponents.id within this source."
      },
      ...icsItem,
      position: {
        ...ordinal2,
        description: "Index of the parameter within its property, in export order."
      },
      valuePosition: {
        ...ordinal2,
        description: "Index of this value within the parameter."
      },
      name: {
        ...text2,
        description: "Parameter name as exported, uppercased."
      },
      value: {
        ...text2,
        description: "One parameter value, with surrounding double quotes removed and RFC 6868 caret escapes (^n, ^', ^^) decoded; otherwise as exported."
      }
    }
  },
  attendees: {
    description: `One source record per participant of an event occurrence: its organizer and each attendee. ${perOccurrence} eventId refers to events.eventId. Relationships name source streams, not destination tables.`,
    properties: attendeeFields
  },
  alarms: {
    description: `One source record per EventKit alarm of an event occurrence. ${perOccurrence} eventId refers to events.eventId. Relationships name source streams, not destination tables.`,
    properties: alarmFields
  },
  recurrenceRules: {
    description: `One source record per EventKit recurrence rule of a recurring event occurrence. ${perOccurrence} eventId refers to events.eventId; recurrenceRuleValues holds each rule's list values. Relationships name source streams, not destination tables.`,
    properties: recurrenceRuleFields
  },
  recurrenceRuleValues: {
    description: `One source record per entry of a recurrence rule's day, week, month or set-position lists. ${perOccurrence} ruleId refers to recurrenceRules.id and eventId to events.eventId. Relationships name source streams, not destination tables.`,
    properties: recurrenceRuleValueFields
  }
};
var catalog = new Catalog(Object.entries(streams).map(([name2, { description, properties }]) => new Stream({
  name: name2,
  jsonSchema: {
    type: "object",
    description,
    properties,
    required: Object.keys(properties)
  },
  primaryKey: ["id"],
  // Every read is the whole window, so incremental copies diff snapshots.
  supportedSyncModes: ["full_refresh", "incremental"],
  sourceDefinedCursor: true,
  emitsDeletes: true,
  ...name2 === "icsAttachments" && { supportsFileTransfer: true }
})));

// packages/sources/apple/calendar/dist/icalendar.js
var namePattern = /^[A-Za-z0-9-]+/;
function parseICalendar(bytes) {
  let text3;
  try {
    text3 = new TextDecoder("utf-8", { fatal: true }).decode(unfold(bytes));
  } catch (cause) {
    throw new TypeError("iCalendar data is not valid UTF-8", { cause });
  }
  const lines = text3.split(/\r?\n/);
  if (lines.at(-1) === "")
    lines.pop();
  const stack = [];
  let root;
  for (const [index, line] of lines.entries()) {
    const fail = (reason) => new TypeError(`iCalendar line ${index + 1}: ${reason}`);
    if (root !== void 0 && stack.length === 0)
      throw fail("content after the calendar ended");
    const property = parseLine(line, fail);
    if (property.name === "BEGIN") {
      const component = {
        name: property.value.toUpperCase(),
        properties: [],
        components: []
      };
      if (!namePattern.test(component.name))
        throw fail(`invalid component name ${property.value}`);
      const parent = stack.at(-1);
      if (parent === void 0) {
        if (component.name !== "VCALENDAR")
          throw fail("content must start with BEGIN:VCALENDAR");
        root = component;
      } else
        parent.components.push(component);
      stack.push(component);
    } else if (property.name === "END") {
      const open = stack.pop();
      if (open === void 0 || open.name !== property.value.toUpperCase())
        throw fail(`END:${property.value} does not close ${open?.name ?? "anything"}`);
    } else {
      const open = stack.at(-1);
      if (open === void 0)
        throw fail("property outside a component");
      open.properties.push(property);
    }
  }
  if (root === void 0)
    throw new TypeError("iCalendar data has no VCALENDAR");
  if (stack.length > 0)
    throw new TypeError(`iCalendar component ${stack.at(-1)?.name} is not closed`);
  return freeze(root);
}
function unfold(bytes) {
  const out = new Uint8Array(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    if (byte === void 0)
      break;
    const lf = byte === 13 && bytes[index + 1] === 10 ? index + 1 : byte === 10 ? index : -1;
    const next = lf === -1 ? void 0 : bytes[lf + 1];
    if (next === 32 || next === 9) {
      index = lf + 1;
      continue;
    }
    out[length++] = byte;
  }
  return out.subarray(0, length);
}
function parseLine(line, fail) {
  const name2 = namePattern.exec(line)?.[0];
  if (name2 === void 0)
    throw fail("missing property name");
  let position = name2.length;
  const parameters = [];
  while (line[position] === ";") {
    const parameterName = namePattern.exec(line.slice(position + 1))?.[0];
    if (parameterName === void 0 || line[position + 1 + parameterName.length] !== "=")
      throw fail(`invalid parameter in ${name2}`);
    position += parameterName.length + 2;
    const values = [];
    for (; ; ) {
      let value;
      if (line[position] === '"') {
        const end = line.indexOf('"', position + 1);
        if (end === -1)
          throw fail(`unterminated quoted parameter in ${name2}`);
        value = line.slice(position + 1, end);
        position = end + 1;
      } else {
        const end = line.slice(position).search(/[";:,]/);
        const stop = end === -1 ? line.length : position + end;
        if (line[stop] === '"')
          throw fail(`misplaced quote in ${name2}`);
        value = line.slice(position, stop);
        position = stop;
      }
      values.push(decodeCaret(value));
      if (line[position] !== ",")
        break;
      position++;
    }
    parameters.push({ name: parameterName.toUpperCase(), values });
  }
  if (line[position] !== ":")
    throw fail(`missing colon after ${name2}`);
  return {
    name: name2.toUpperCase(),
    parameters,
    value: line.slice(position + 1)
  };
}
function decodeCaret(value) {
  return value.replaceAll(/\^([n'^])/g, (_, code) => code === "n" ? "\n" : code === "'" ? '"' : "^");
}
function freeze(component) {
  return Object.freeze({
    name: component.name,
    properties: Object.freeze(component.properties.map((property) => Object.freeze({
      ...property,
      parameters: Object.freeze(property.parameters.map((parameter) => Object.freeze({
        ...parameter,
        values: Object.freeze(parameter.values)
      })))
    }))),
    components: Object.freeze(component.components.map(freeze))
  });
}

// packages/sources/apple/calendar/dist/ics-records.js
var icsStreams = [
  "icsComponents",
  "icsProperties",
  "icsParameters",
  "icsAttachments"
];
function isIcsStream(name2) {
  return icsStreams.some((stream) => stream === name2);
}
function validateIcsExports(items) {
  if (!Array.isArray(items) || !items.every((item) => item !== null && typeof item === "object" && typeof item.calendarId === "string" && typeof item.calendarItemId === "string" && typeof item.recurring === "boolean" && typeof item.ics === "string"))
    throw new TypeError("EventKit returned an invalid ICS export page");
  return items;
}
function icsRecords(stream, item) {
  const { calendarId, calendarItemId } = item;
  const calendar = parseICalendar(Buffer.from(item.ics, "base64"));
  if (!calendar.components.some((component) => component.name === "VEVENT"))
    throw new TypeError(`EventKit ICS export returned no VEVENT for saved item ${calendarItemId}`);
  const rows = {
    icsComponents: [],
    icsProperties: [],
    icsParameters: [],
    icsAttachments: []
  };
  const walk = (component, path, parentId, position) => {
    const id3 = JSON.stringify([calendarId, calendarItemId, path]);
    const property = (name2) => component.properties.find((candidate) => candidate.name === name2);
    const recurrence = property("RECURRENCE-ID");
    rows.icsComponents.push({
      id: id3,
      calendarId,
      calendarItemId,
      parentId,
      position,
      name: component.name,
      uid: property("UID")?.value ?? null,
      recurrenceId: recurrence?.value ?? null,
      recurrenceIdTimeZone: recurrence?.parameters.find((parameter) => parameter.name === "TZID")?.values[0] ?? null,
      eventId: component.name === "VEVENT" && !item.recurring && !recurrence ? JSON.stringify([calendarId, calendarItemId, null]) : null
    });
    const properties = component.properties.filter((property2) => property2.name !== "DTSTAMP");
    for (const [index, { name: name2, value, parameters }] of properties.entries()) {
      const propertyKey = [calendarId, calendarItemId, path, index];
      const propertyId = JSON.stringify(propertyKey);
      if (name2 === "ATTACH") {
        const parameter = (key) => parameters.find((candidate) => candidate.name === key)?.values[0] ?? null;
        rows.icsAttachments.push({
          id: propertyId,
          propertyId,
          componentId: id3,
          calendarId,
          calendarItemId,
          uri: value,
          filename: parameter("X-APPLE-FILENAME") ?? parameter("FILENAME"),
          formatType: parameter("FMTTYPE"),
          // RFC 5545 inline content: the value is the base64 file itself.
          inline: parameter("VALUE") === "BINARY" || parameter("ENCODING") === "BASE64"
        });
      }
      rows.icsProperties.push({
        id: propertyId,
        componentId: id3,
        calendarId,
        calendarItemId,
        position: index,
        name: name2,
        value
      });
      for (const [parameterIndex, parameter] of parameters.entries())
        for (const [valueIndex, parameterValue] of parameter.values.entries())
          rows.icsParameters.push({
            id: JSON.stringify([...propertyKey, parameterIndex, valueIndex]),
            propertyId,
            componentId: id3,
            calendarId,
            calendarItemId,
            position: parameterIndex,
            valuePosition: valueIndex,
            name: parameter.name,
            value: parameterValue
          });
    }
    for (const [index, child] of component.components.entries())
      walk(child, `${path}.${index}`, id3, index);
  };
  walk(inContentOrder(calendar), "0", null, 0);
  return rows[stream];
}
function inContentOrder(component) {
  const components = component.components.map(inContentOrder).map((child) => [JSON.stringify(child), child]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, child]) => child);
  return { ...component, components };
}

// packages/sources/apple/calendar/dist/calendar-rows.js
function calendarRows(contents) {
  const events = /* @__PURE__ */ new Map();
  const related = [];
  for (const occurrence of contents.occurrences) {
    const event = eventRow(occurrence);
    if (events.has(event.eventId))
      continue;
    events.set(event.eventId, event);
    related.push(relatedRows(occurrence, event.eventId));
  }
  const items = validateIcsExports(contents.icsExports);
  return new Map([
    ["accounts", contents.accounts.map(accountRow)],
    ["calendars", contents.calendars.map(calendarRow)],
    ["events", [...events.values()]],
    ["attendees", related.flatMap((rows) => rows.attendees)],
    ["alarms", related.flatMap((rows) => rows.alarms)],
    ["recurrenceRules", related.flatMap((rows) => rows.recurrenceRules)],
    [
      "recurrenceRuleValues",
      related.flatMap((rows) => rows.recurrenceRuleValues)
    ],
    ...icsStreams.map((stream) => [
      stream,
      items.flatMap((item) => icsRecords(stream, item))
    ])
  ]);
}
function timestamp2(ms) {
  return ms === void 0 ? null : new Date(ms).toISOString();
}
function location2(place) {
  return {
    locationTitle: place?.title ?? null,
    latitude: place?.latitude ?? null,
    longitude: place?.longitude ?? null,
    radius: place?.radius ?? null
  };
}
function accountRow(account) {
  return {
    id: account.id,
    name: account.name,
    type: account.sourceType,
    isDelegate: account.isDelegate
  };
}
function calendarRow(calendar) {
  return {
    id: calendar.id,
    accountId: calendar.accountId ?? null,
    name: calendar.name,
    type: calendar.calendarType,
    writable: calendar.writable,
    subscribed: calendar.subscribed,
    immutable: calendar.immutable,
    colorRed: calendar.color?.[0] ?? null,
    colorGreen: calendar.color?.[1] ?? null,
    colorBlue: calendar.color?.[2] ?? null,
    colorAlpha: calendar.color?.[3] ?? null,
    supportedAvailabilities: calendar.supportedAvailabilities,
    allowedEntityTypes: calendar.allowedEntityTypes,
    description: calendar.notes ?? ""
  };
}
function eventRow(occurrence) {
  const recurring = occurrence.recurrenceRules.length > 0 || occurrence.detached;
  if (recurring && occurrence.occurrenceMs === void 0)
    throw new TypeError("EventKit returned a recurring event without an occurrence date");
  let occurrenceKey = null;
  if (recurring)
    occurrenceKey = occurrence.allDay ? occurrence.occurrenceDay ?? null : timestamp2(occurrence.occurrenceMs);
  const eventId2 = JSON.stringify([
    occurrence.calendarId,
    occurrence.calendarItemId,
    occurrenceKey
  ]);
  const { allDay } = occurrence;
  const place = location2(occurrence.place);
  return {
    id: eventId2,
    eventId: eventId2,
    calendarId: occurrence.calendarId,
    calendarItemId: occurrence.calendarItemId,
    externalId: occurrence.externalId ?? null,
    nativeEventId: occurrence.nativeEventId ?? null,
    name: occurrence.name ?? null,
    body: occurrence.body ?? null,
    location: occurrence.location ?? null,
    url: occurrence.url ?? null,
    startAt: timestamp2(occurrence.startMs),
    endAt: timestamp2(occurrence.endMs),
    allDay,
    startDate: allDay ? occurrence.startDay : null,
    endDate: allDay ? occurrence.endDay : null,
    timeZone: occurrence.timeZone ?? null,
    createdAt: timestamp2(occurrence.createdMs),
    modifiedAt: timestamp2(occurrence.modifiedMs),
    occurrenceAt: recurring ? timestamp2(occurrence.occurrenceMs) : null,
    occurrenceDate: allDay && recurring ? occurrence.occurrenceDay ?? null : null,
    detached: occurrence.detached,
    status: occurrence.status,
    availability: occurrence.availability,
    birthdayContactId: occurrence.birthdayContactId ?? null,
    ...place
  };
}
function participantRow(eventId2, participant, kind, position) {
  return {
    id: JSON.stringify([eventId2, kind, position]),
    eventId: eventId2,
    position,
    kind,
    name: participant.name ?? null,
    url: participant.url,
    status: participant.status,
    role: participant.role,
    type: participant.participantType,
    isCurrentUser: participant.isCurrentUser
  };
}
function alarmRow(eventId2, alarm, position) {
  return {
    id: JSON.stringify([eventId2, position]),
    eventId: eventId2,
    position,
    type: alarm.alarmType,
    relativeOffset: alarm.relativeOffset,
    absoluteAt: timestamp2(alarm.absoluteMs),
    emailAddress: alarm.emailAddress ?? null,
    soundName: alarm.soundName ?? null,
    proximity: alarm.proximity,
    ...location2(alarm.location)
  };
}
function relatedRows(occurrence, eventId2) {
  const attendees = [];
  if (occurrence.organizer !== void 0)
    attendees.push(participantRow(eventId2, occurrence.organizer, "organizer", 0));
  for (const [position, attendee] of occurrence.attendees.entries())
    attendees.push(participantRow(eventId2, attendee, "attendee", position));
  const alarms = occurrence.alarms.map((alarm, position) => alarmRow(eventId2, alarm, position));
  const recurrenceRules = [];
  const recurrenceRuleValues = [];
  for (const [position, rule] of occurrence.recurrenceRules.entries()) {
    const ruleId = JSON.stringify([eventId2, "recurrenceRule", position]);
    recurrenceRules.push({
      id: ruleId,
      eventId: eventId2,
      position,
      calendarIdentifier: rule.calendarIdentifier ?? null,
      frequency: rule.frequency,
      interval: rule.interval,
      firstDayOfWeek: rule.firstDayOfWeek,
      endAt: timestamp2(rule.end?.endMs),
      occurrenceCount: rule.end?.occurrenceCount ?? 0
    });
    const valueRow = (component, position2, value, weekNumber) => ({
      id: JSON.stringify([ruleId, component, position2]),
      eventId: eventId2,
      ruleId,
      component,
      position: position2,
      value,
      weekNumber
    });
    for (const [position2, day] of rule.daysOfTheWeek.entries())
      recurrenceRuleValues.push(valueRow("daysOfTheWeek", position2, day.day, day.weekNumber));
    for (const component of [
      "daysOfTheMonth",
      "daysOfTheYear",
      "weeksOfTheYear",
      "monthsOfTheYear",
      "setPositions"
    ])
      for (const [position2, value] of rule[component].entries())
        recurrenceRuleValues.push(valueRow(component, position2, value, null));
  }
  return { attendees, alarms, recurrenceRules, recurrenceRuleValues };
}

// packages/sources/apple/calendar/dist/calendar-snapshot.js
var CalendarSnapshot = class {
  #records;
  constructor(records) {
    this.#records = records;
  }
  of(stream) {
    const records = this.#records.get(stream);
    if (records === void 0)
      throw new TypeError(`Stream ${stream} was not read in this session`);
    return records;
  }
  async [Symbol.asyncDispose]() {
  }
};

// packages/sources/apple/calendar/dist/apple-calendar-source.js
var CalendarIcsUnavailableError = class extends Error {
  name = "CalendarIcsUnavailableError";
  constructor(cause) {
    super("This macOS version does not provide the private EventKit ICS export that the Calendar ICS streams read. Select the other Calendar streams, which use public EventKit.", { cause });
  }
};
var AppleCalendarSource = class extends Source {
  #store;
  // The window is not part of the identity: moving it keeps one checkpoint, and
  // incremental copies delete the occurrences that left it.
  identity = "apple-calendar:eventkit";
  catalog = catalog;
  startAt;
  endAt;
  scope;
  accounts = catalog.get("accounts");
  calendars = catalog.get("calendars");
  events = catalog.get("events");
  attendees = catalog.get("attendees");
  alarms = catalog.get("alarms");
  recurrenceRules = catalog.get("recurrenceRules");
  recurrenceRuleValues = catalog.get("recurrenceRuleValues");
  icsComponents = catalog.get("icsComponents");
  icsProperties = catalog.get("icsProperties");
  icsParameters = catalog.get("icsParameters");
  icsAttachments = catalog.get("icsAttachments");
  #attachments;
  constructor({ store, startAt, endAt, attachments, scope = {} }) {
    super();
    this.#store = store;
    this.#attachments = attachments;
    if (!isTimestamp(startAt) || !isTimestamp(endAt) || startAt >= endAt)
      throw new TypeError("Calendar requires canonical UTC startAt < endAt timestamps");
    this.startAt = startAt;
    this.endAt = endAt;
    this.scope = scope;
    Object.freeze(this);
  }
  coverage(stream) {
    if (stream === this.accounts || stream === this.calendars)
      return {
        description: "All Calendar accounts or calendars visible through EventKit on this Mac. No date filter; the event window does not restrict these listings.",
        selection: this.scope
      };
    return {
      description: "EventKit event occurrences overlapping the configured UTC interval [startAt, endAt); zero-duration events must start within it. Related rows and ICS exports belong to those selected events; ICS may describe a recurring series beyond the interval. Only calendars visible on this Mac are included. This is a requested window, not observed event dates. Attachment metadata may exist without retrievable file bytes.",
      selection: { ...this.scope, startAt: this.startAt, endAt: this.endAt }
    };
  }
  async *observe({ streams: streams2, signal }) {
    for await (const _ of this.#store.watch(signal))
      yield streams2;
  }
  // Every selected stream from one change-free read, so occurrences match
  // their calendars and ICS rows their items.
  async open(streams2) {
    const rows = calendarRows(await this.#read({
      startAt: this.startAt,
      endAt: this.endAt,
      ics: streams2.some((stream) => isIcsStream(stream.name)),
      accountIds: this.scope.accountIds,
      calendarIds: this.scope.collectionIds
    }));
    return new CalendarSnapshot(new Map(streams2.map((stream) => {
      const records = validateRecords(stream, rows.get(stream.name), "EventKit");
      if (stream.name === "events")
        records.forEach(checkEventDates);
      return [stream.name, records];
    })));
  }
  async #read(query) {
    try {
      return await this.#store.read(query);
    } catch (error) {
      if (error instanceof IcsExportUnavailableError)
        throw new CalendarIcsUnavailableError(error);
      throw error;
    }
  }
  async *extract(configuration, state, _partition, snapshot) {
    const { stream, syncMode } = configuration;
    const records = snapshot.of(stream.name);
    if (syncMode === "incremental") {
      for await (const message of diffSnapshot(stream, records, state))
        if ("type" in message)
          yield message;
        else
          yield* this.withFile(configuration, message.data);
      return;
    }
    for (const data of records)
      yield* this.withFile(configuration, data);
  }
  // Stages an attachment's bytes when the copy reads them, like Notes attachments.
  async *withFile(configuration, data) {
    var _stack = [];
    try {
      const stream = configuration.stream.name;
      if (stream !== "icsAttachments" || configuration.fileReads.length === 0) {
        yield { stream, data };
        return;
      }
      const attachment = {
        uri: String(data.uri),
        // Validated against the icsAttachments schema: nullable text.
        filename: data.filename === null ? null : String(data.filename),
        formatType: data.formatType === null ? null : String(data.formatType),
        calendarId: String(data.calendarId),
        calendarItemId: String(data.calendarItemId)
      };
      const scratch = __using(_stack, await mkdtempDisposable(join(tmpdir(), "context-compiler-calendar-attachment-")), true);
      const extension = attachment.filename === null ? "" : extname(attachment.filename);
      const path = join(scratch.path, `content${extension}`);
      let saved;
      if (data.inline === true) {
        await writeFile(path, Buffer.from(attachment.uri, "base64"));
        saved = true;
      } else {
        if (this.#attachments === void 0)
          throw new TypeError("Reading Calendar attachment files requires an attachments fetcher: new AppleCalendarSource({ ..., attachments })");
        saved = await this.#attachments(attachment, path);
      }
      if (saved && !(await lstat(path)).isFile())
        throw new TypeError("The attachment fetcher did not write a regular file");
      yield { stream, data, file: saved ? path : null };
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      var _promise = __callDispose(_stack, _error, _hasError);
      _promise && await _promise;
    }
  }
};
function checkEventDates(event) {
  const endsBeforeStart = String(event.endAt) < String(event.startAt);
  let datesInconsistent;
  if (event.allDay)
    datesInconsistent = event.startDate === null || event.endDate === null || String(event.endDate) < String(event.startDate);
  else
    datesInconsistent = event.startDate !== null || event.endDate !== null;
  if (endsBeforeStart || datesInconsistent)
    throw new TypeError("Calendar returned inconsistent event dates");
}

// apps/apple/connectors/dist/apps/calendar/calendar-app.mjs
var CalendarApp = class extends AppleApp {
  name = "calendar";
  title = "Calendar";
  datedBy = "event dates (events that overlap the range)";
  fullDiskAccess = false;
  choices = [
    accounts(name),
    collections("calendars", "calendars")
  ];
  unscoped = [];
  storeCopies = [];
  access(grantee) {
    return `Allow ${grantee} full Calendar access when macOS asks, or in System Settings \u203A Privacy & Security \u203A Calendars.`;
  }
  // Calendar reads occurrences within a window: every event from 2000 to a
  // year ahead.
  defaultScope() {
    const end = /* @__PURE__ */ new Date();
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    return { startAt: "2000-01-01T00:00:00.000Z", endAt: end.toISOString() };
  }
  // Listing calendars leaves remote attachments as links.
  source(scope) {
    return this.#calendar(scope, async () => false);
  }
  // An import downloads attachments stored in Google Drive and Gmail when
  // the host offers a Google session. The Google client loads only then, so
  // a host without one never runs it.
  async importSource(scope) {
    if (this.host.google === void 0)
      return this.source(scope);
    const google = await this.host.google([
      GOOGLE_DRIVE_READONLY_SCOPE,
      GMAIL_READONLY_SCOPE
    ]);
    const { googleCalendarAttachments } = await import("../../chunks/google-calendar-attachments-OZZRMXLH.mjs");
    return this.#calendar(scope, googleCalendarAttachments(google));
  }
  #calendar(scope, attachments) {
    const window = this.defaultScope();
    return new AppleCalendarSource({
      store: new CalendarStore(this.host.eventKitHelper),
      startAt: scope.startAt ?? window.startAt,
      endAt: scope.endAt ?? window.endAt,
      scope,
      attachments
    });
  }
};
export {
  CalendarApp as default
};
