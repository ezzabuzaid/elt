import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  CalendarStore,
  IcsExportUnavailableError
} from "../../chunks/chunk-TWJG64VL.mjs";
import {
  accounts,
  collections,
  name
} from "../../chunks/chunk-FGFSL4M6.mjs";
import {
  eventKitFields
} from "../../chunks/chunk-YUEL2AIL.mjs";
import {
  AppleConnector
} from "../../chunks/chunk-TI6UOZR6.mjs";
import {
  Catalog,
  Source,
  Stream,
  diffSnapshot,
  isTimestamp,
  validateRecords
} from "../../chunks/chunk-L4HYJU4U.mjs";
import {
  __callDispose,
  __using
} from "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/google-auth/dist/scopes.js
var GOOGLE_DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
var GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

// packages/sources/apple/calendar/dist/apple-calendar-source.js
import { mkdtempDisposable, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";

// packages/sources/apple/calendar/dist/icalendar.js
var namePattern = /^[A-Za-z0-9-]+/;
function parseICalendar(bytes) {
  let text11;
  try {
    text11 = new TextDecoder("utf-8", { fatal: true }).decode(unfold(bytes));
  } catch (cause) {
    throw new TypeError("iCalendar data is not valid UTF-8", { cause });
  }
  const lines = text11.split(/\r?\n/);
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

// packages/sources/apple/calendar/dist/calendar-scan.js
function timestamp(ms) {
  return ms === void 0 ? null : new Date(ms).toISOString();
}
function location(place) {
  return {
    locationTitle: place?.title ?? null,
    latitude: place?.latitude ?? null,
    longitude: place?.longitude ?? null,
    radius: place?.radius ?? null
  };
}
var CalendarScan = class {
  #contents;
  #attachments;
  #events;
  #rules;
  #ics;
  constructor(contents, attachments) {
    this.#contents = contents;
    this.#attachments = attachments;
  }
  get accounts() {
    return this.#contents.accounts;
  }
  get calendars() {
    return this.#contents.calendars;
  }
  // The store lists an occurrence once for each read window it spans; its
  // first copy is kept.
  get events() {
    if (this.#events === void 0) {
      const events = /* @__PURE__ */ new Map();
      for (const occurrence of this.#contents.occurrences) {
        const event = identify(occurrence);
        if (!events.has(event.eventId))
          events.set(event.eventId, event);
      }
      this.#events = [...events.values()];
    }
    return this.#events;
  }
  get rules() {
    this.#rules ??= this.events.flatMap(({ eventId: eventId5, occurrence }) => occurrence.recurrenceRules.map((rule, position) => ({
      eventId: eventId5,
      ruleId: JSON.stringify([eventId5, "recurrenceRule", position]),
      position,
      rule
    })));
    return this.#rules;
  }
  get ics() {
    this.#ics ??= walk(validateIcsExports(this.#contents.icsExports));
    return this.#ics;
  }
  // Writes an attachment's bytes to path through the fetcher the app supplied.
  async fetch(attachment, path) {
    if (this.#attachments === void 0)
      throw new TypeError("Reading Calendar attachment files requires an attachments fetcher: new AppleCalendarSource({ ..., attachments })");
    return this.#attachments(attachment, path);
  }
  async [Symbol.asyncDispose]() {
  }
};
function identify(occurrence) {
  const recurring = occurrence.recurrenceRules.length > 0 || occurrence.detached;
  if (recurring && occurrence.occurrenceMs === void 0)
    throw new TypeError("EventKit returned a recurring event without an occurrence date");
  let occurrenceKey = null;
  if (recurring)
    occurrenceKey = occurrence.allDay ? occurrence.occurrenceDay ?? null : timestamp(occurrence.occurrenceMs);
  const eventId5 = JSON.stringify([
    occurrence.calendarId,
    occurrence.calendarItemId,
    occurrenceKey
  ]);
  return { eventId: eventId5, recurring, occurrence };
}
function validateIcsExports(items) {
  if (!Array.isArray(items) || !items.every((item) => item !== null && typeof item === "object" && typeof item.calendarId === "string" && typeof item.calendarItemId === "string" && typeof item.recurring === "boolean" && typeof item.ics === "string"))
    throw new TypeError("EventKit returned an invalid ICS export page");
  return items;
}
function walk(exports) {
  const components = [];
  const properties12 = [];
  for (const { ics, ...item } of exports) {
    const { calendarId, calendarItemId } = item;
    const calendar = parseICalendar(Buffer.from(ics, "base64"));
    if (!calendar.components.some((component) => component.name === "VEVENT"))
      throw new TypeError(`EventKit ICS export returned no VEVENT for saved item ${calendarItemId}`);
    const visit = (component, path, parentId, position) => {
      const id13 = JSON.stringify([calendarId, calendarItemId, path]);
      components.push({ item, id: id13, parentId, position, component });
      const lines = component.properties.filter((property) => property.name !== "DTSTAMP");
      for (const [index, property] of lines.entries()) {
        const key = [calendarId, calendarItemId, path, index];
        properties12.push({
          item,
          componentId: id13,
          key,
          id: JSON.stringify(key),
          position: index,
          property
        });
      }
      for (const [index, child] of component.components.entries())
        visit(child, `${path}.${index}`, id13, index);
    };
    visit(inContentOrder(calendar), "0", null, 0);
  }
  return { components, properties: properties12 };
}
function compareCodeUnits(a, b) {
  if (a < b)
    return -1;
  if (a > b)
    return 1;
  return 0;
}
function inContentOrder(component) {
  const components = component.components.map(inContentOrder).map((child) => [JSON.stringify(child), child]).sort(([a], [b]) => compareCodeUnits(a, b)).map(([, child]) => child);
  return { ...component, components };
}

// packages/sources/apple/calendar/dist/calendar-stream.js
var { id, location: location2 } = eventKitFields;
var calendarFields = {
  ...eventKitFields,
  color: { type: ["number", "null"], minimum: 0, maximum: 1 },
  eventId: {
    ...id,
    description: "Owning event occurrence; refers to events.eventId within this source."
  },
  // ICS rows describe a whole native item, not one occurrence.
  icsItem: {
    calendarId: {
      ...id,
      description: "EventKit calendar identifier of the exported item; refers to calendars.id within this source."
    },
    calendarItemId: {
      ...id,
      description: "EventKit EKCalendarItem.calendarItemIdentifier of the exported item. With calendarId it matches events of every occurrence of that item."
    }
  }
};
function locationFields(property) {
  return {
    locationTitle: {
      ...location2.locationTitle,
      description: `EventKit ${property}.title; NULL when there is no structured location or it has no title.`
    },
    latitude: {
      ...location2.latitude,
      description: `Latitude in degrees of EventKit ${property}.geoLocation; NULL when there is no structured location or it has no coordinate.`
    },
    longitude: {
      ...location2.longitude,
      description: `Longitude in degrees of EventKit ${property}.geoLocation; NULL when there is no structured location or it has no coordinate.`
    },
    radius: {
      ...location2.radius,
      description: `EventKit ${property}.radius in meters; 0 means EventKit's default radius. NULL when there is no structured location.`
    }
  };
}
var perOccurrence = "Rows belong to an occurrence, not a series: each selected occurrence of a recurring series repeats them, so counts across a series multiply.";
var CalendarStream = class {
  primaryKey = ["id"];
  supportedSyncModes = Object.freeze([
    "full_refresh",
    "incremental"
  ]);
  // Every read is the whole window, so incremental copies diff snapshots.
  sourceDefinedCursor = true;
  emitsDeletes = true;
  // Whether a read must ask EventKit for the private ICS export.
  requiresIcs = false;
  // Whether the event window limits the stream; the account and calendar
  // listings it does not.
  dated = true;
  #stream;
  describe() {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }
  async read(scan) {
    return validateRecords(this, this.rows(scan).map((row) => this.record(row, scan)), "EventKit");
  }
  // The file a record carries, for streams that support file reads, staged
  // under staging.
  async file(_record, _scan, _staging) {
    return null;
  }
};

// packages/sources/apple/calendar/dist/streams/accounts-stream.js
var { id: id2, text, ordinal, boolean } = calendarFields;
var properties = {
  id: {
    ...id2,
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
var AccountsStream = class extends CalendarStream {
  name = "accounts";
  jsonSchema = {
    type: "object",
    description: "One source record per EventKit account (EKSource) in this Mac's event store, including accounts without event calendars. No date filter: the event window does not restrict it. An import scope keeps the selected accounts; a calendar scope also drops accounts owning no selected calendar. Relationships name source streams, not destination tables.",
    properties,
    required: Object.keys(properties)
  };
  dated = false;
  rows(scan) {
    return scan.accounts;
  }
  record(account) {
    return {
      id: account.id,
      name: account.name,
      type: account.sourceType,
      isDelegate: account.isDelegate
    };
  }
};

// packages/sources/apple/calendar/dist/streams/alarms-stream.js
var { id: id3, eventId, ordinal: ordinal2, number, nullableTimestamp, nullableText } = calendarFields;
var properties2 = {
  id: {
    ...id3,
    description: "JSON [eventId, position]; unique within this stream."
  },
  eventId,
  position: {
    ...ordinal2,
    description: "Order among the owner's alarms, numbered in content order, not EventKit's order, which changes between reads."
  },
  type: {
    ...ordinal2,
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
    ...ordinal2,
    description: "EventKit EKAlarm.proximity raw value (EKAlarmProximity): 0 none, 1 fires on entering, 2 on leaving the structured location. Unknown codes are kept as numbers."
  },
  ...locationFields("EKAlarm.structuredLocation")
};
var AlarmsStream = class extends CalendarStream {
  name = "alarms";
  jsonSchema = {
    type: "object",
    description: `One source record per EventKit alarm of an event occurrence. ${perOccurrence} eventId refers to events.eventId. Relationships name source streams, not destination tables.`,
    properties: properties2,
    required: Object.keys(properties2)
  };
  // The store lists alarms in a stable order, so positions are stable.
  rows(scan) {
    return scan.events.flatMap(({ eventId: eventId5, occurrence }) => occurrence.alarms.map((alarm, position) => ({
      eventId: eventId5,
      position,
      alarm
    })));
  }
  record({ eventId: eventId5, position, alarm }) {
    return {
      id: JSON.stringify([eventId5, position]),
      eventId: eventId5,
      position,
      type: alarm.alarmType,
      relativeOffset: alarm.relativeOffset,
      absoluteAt: timestamp(alarm.absoluteMs),
      emailAddress: alarm.emailAddress ?? null,
      soundName: alarm.soundName ?? null,
      proximity: alarm.proximity,
      ...location(alarm.location)
    };
  }
};

// packages/sources/apple/calendar/dist/streams/attendees-stream.js
var { id: id4, eventId: eventId2, ordinal: ordinal3, text: text2, nullableText: nullableText2, boolean: boolean2 } = calendarFields;
var properties3 = {
  id: {
    ...id4,
    description: "JSON [eventId, kind, position]; unique within this stream."
  },
  eventId: eventId2,
  position: {
    ...ordinal3,
    description: "Order among the owner's participants of the same kind. Attendees are numbered in content order (URL, name, role, type), not EventKit's order, which changes between reads."
  },
  kind: {
    ...text2,
    description: "'organizer' for EventKit EKEvent.organizer, always at position 0, or 'attendee' for an entry of EKCalendarItem.attendees."
  },
  name: {
    ...nullableText2,
    description: "EventKit EKParticipant.name; NULL when EventKit has none."
  },
  url: {
    ...nullableText2,
    description: "EventKit EKParticipant.URL as a string."
  },
  status: {
    ...ordinal3,
    description: "EventKit EKParticipant.participantStatus raw value (EKParticipantStatus): 0 unknown, 1 pending, 2 accepted, 3 declined, 4 tentative, 5 delegated, 6 completed, 7 in process. Unknown codes are kept as numbers."
  },
  role: {
    ...ordinal3,
    description: "EventKit EKParticipant.participantRole raw value (EKParticipantRole): 0 unknown, 1 required, 2 optional, 3 chair, 4 non-participant. Unknown codes are kept as numbers."
  },
  type: {
    ...ordinal3,
    description: "EventKit EKParticipant.participantType raw value (EKParticipantType): 0 unknown, 1 person, 2 room, 3 resource, 4 group. Unknown codes are kept as numbers."
  },
  isCurrentUser: {
    ...boolean2,
    description: "EventKit EKParticipant.isCurrentUser: whether the participant is the owner of this account."
  }
};
var AttendeesStream = class extends CalendarStream {
  name = "attendees";
  jsonSchema = {
    type: "object",
    description: `One source record per participant of an event occurrence: its organizer and each attendee. ${perOccurrence} eventId refers to events.eventId. Relationships name source streams, not destination tables.`,
    properties: properties3,
    required: Object.keys(properties3)
  };
  // The store lists attendees in a stable order, so positions are stable.
  rows(scan) {
    return scan.events.flatMap(({ eventId: eventId5, occurrence }) => [
      ...occurrence.organizer === void 0 ? [] : [
        {
          eventId: eventId5,
          kind: "organizer",
          position: 0,
          participant: occurrence.organizer
        }
      ],
      ...occurrence.attendees.map((participant, position) => ({
        eventId: eventId5,
        kind: "attendee",
        position,
        participant
      }))
    ]);
  }
  record({ eventId: eventId5, kind, position, participant }) {
    return {
      id: JSON.stringify([eventId5, kind, position]),
      eventId: eventId5,
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
};

// packages/sources/apple/calendar/dist/streams/calendars-stream.js
var { id: id5, text: text3, ordinal: ordinal4, boolean: boolean3, color } = calendarFields;
var properties4 = {
  id: {
    ...id5,
    description: "EventKit EKCalendar.calendarIdentifier. Apple documents that a full sync can replace it, so it is not a stable identity."
  },
  accountId: {
    ...id5,
    description: "EventKit EKCalendar.source.sourceIdentifier: the owning account; refers to accounts.id within this source."
  },
  name: { ...text3, description: "EventKit EKCalendar.title." },
  type: {
    ...ordinal4,
    description: "EventKit EKCalendar.type raw value (EKCalendarType): 0 local, 1 CalDAV, 2 Exchange, 3 subscription, 4 birthday. Apple reports a subscribed CalDAV calendar as 1 with subscribed true. Unknown codes are kept as numbers."
  },
  writable: {
    ...boolean3,
    description: "EventKit EKCalendar.allowsContentModifications: whether items can be added, removed or modified in it."
  },
  subscribed: { ...boolean3, description: "EventKit EKCalendar.isSubscribed." },
  immutable: {
    ...boolean3,
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
    ...ordinal4,
    description: "EventKit EKCalendar.supportedEventAvailabilities bitmask (EKCalendarEventAvailabilityMask): 1 busy, 2 free, 4 tentative, 8 unavailable; 0 when the calendar does not support event availability."
  },
  allowedEntityTypes: {
    ...ordinal4,
    description: "EventKit EKCalendar.allowedEntityTypes bitmask (EKEntityMask): 1 events, 2 reminders."
  },
  description: {
    ...text3,
    description: "Calendar.app's calendar description, read from EKCalendar's private notes property; empty when the calendar has none."
  }
};
var CalendarsStream = class extends CalendarStream {
  name = "calendars";
  jsonSchema = {
    type: "object",
    description: "One source record per event calendar visible through EventKit on this Mac. No date filter: the event window does not restrict it. An import scope keeps only the selected calendars. accountId refers to accounts.id; events and ICS rows refer to id through calendarId. Relationships name source streams, not destination tables.",
    properties: properties4,
    required: Object.keys(properties4)
  };
  dated = false;
  rows(scan) {
    return scan.calendars;
  }
  record(calendar) {
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
};

// packages/sources/apple/calendar/dist/streams/events-stream.js
var { id: id6, text: text4, nullableText: nullableText3, timestamp: timestampField, nullableTimestamp: nullableTimestamp2, nullableDate, boolean: boolean4, ordinal: ordinal5, integer } = calendarFields;
var properties5 = {
  id: { ...id6, description: "Same value as eventId; the record key." },
  eventId: {
    ...id6,
    description: "Occurrence identity: JSON [calendarId, calendarItemId, occurrenceKey]. occurrenceKey is NULL for a nonrecurring event, occurrenceDate for a recurring all-day event and occurrenceAt for a recurring timed event, so moving an occurrence keeps its identity. An event is recurring when it has recurrence rules or is detached. Related EventKit rows join here."
  },
  calendarId: {
    ...id6,
    description: "EventKit EKCalendarItem.calendar.calendarIdentifier; refers to calendars.id within this source."
  },
  calendarItemId: {
    ...id6,
    description: "EventKit EKCalendarItem.calendarItemIdentifier of the native item; every occurrence of a recurring series shares it. ICS rows relate on (calendarId, calendarItemId). Apple documents that a full sync can replace it."
  },
  externalId: {
    ...nullableText3,
    description: "EventKit EKCalendarItem.calendarItemExternalIdentifier, the server-provided identifier shared by every occurrence of a series; NULL when EventKit has none. Apple documents duplicates across calendars (imports, shared or delegated calendars), so it is not unique."
  },
  nativeEventId: {
    ...nullableText3,
    description: "EventKit EKEvent.eventIdentifier; NULL when EventKit has none. Apple documents that it can change when the event moves calendar or syncs; it is not the occurrence identity."
  },
  name: { ...text4, description: "EventKit EKCalendarItem.title." },
  body: {
    ...nullableText3,
    description: "EventKit EKCalendarItem.notes; NULL when unset."
  },
  location: {
    ...nullableText3,
    description: "EventKit EKCalendarItem.location; NULL when unset."
  },
  url: {
    ...nullableText3,
    description: "EventKit EKCalendarItem.URL as a string; NULL when unset."
  },
  startAt: {
    ...timestampField,
    description: "EventKit EKEvent.startDate as a UTC timestamp. Apple returns a floating event, such as an all-day event, in the default time zone of the process that read it; use startDate for all-day days."
  },
  endAt: {
    ...timestampField,
    description: "EventKit EKEvent.endDate as a UTC timestamp; never before startAt. Floating events use the reading process time zone, as startAt does."
  },
  allDay: { ...boolean4, description: "EventKit EKEvent.isAllDay." },
  startDate: {
    ...nullableDate,
    description: "For an all-day event, the local calendar date of EventKit EKEvent.startDate in the default time zone of the process that read it, as Calendar shows it; NULL for a timed event."
  },
  endDate: {
    ...nullableDate,
    description: "For an all-day event, the local calendar date of EventKit EKEvent.endDate in the default time zone of the process that read it, not adjusted to an inclusive or exclusive end; NULL for a timed event."
  },
  timeZone: {
    ...nullableText3,
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
    ...boolean4,
    description: "EventKit EKEvent.isDetached: an occurrence of a recurring series changed from what the series generates."
  },
  status: {
    ...ordinal5,
    description: "EventKit EKEvent.status raw value (EKEventStatus): 0 none, 1 confirmed, 2 tentative, 3 canceled. Apple documents only canceled as reliable. Unknown codes are kept as numbers."
  },
  availability: {
    ...integer,
    description: "EventKit EKEvent.availability raw value (EKEventAvailability): -1 not supported by the calendar, 0 busy, 1 free, 2 tentative, 3 unavailable. Unknown codes are kept as numbers."
  },
  birthdayContactId: {
    ...nullableText3,
    description: "EventKit EKEvent.birthdayContactIdentifier, a Contacts framework contact identifier set only for events of the Birthdays calendar; NULL otherwise. Not verified to match identifiers of the Apple Contacts source."
  },
  ...locationFields("EKEvent.structuredLocation")
};
var EventsStream = class extends CalendarStream {
  name = "events";
  jsonSchema = {
    type: "object",
    description: "One source record per event occurrence, not per series: a recurring event yields one record for each occurrence overlapping the configured UTC interval [startAt, endAt); a zero-duration event must start inside it. Key id equals eventId, JSON [calendarId, calendarItemId, occurrenceKey]; never substitute nativeEventId or startAt for it. attendees, alarms, recurrenceRules and recurrenceRuleValues join on eventId. ICS rows describe the whole native item at (calendarId, calendarItemId) and can cover occurrences outside the interval; only a nonrecurring VEVENT carries eventId. startAt and endAt are UTC instants; startDate and endDate are local calendar dates, set for all-day events only. Only calendars visible on this Mac within the import scope are read. Relationships name source streams, not destination tables.",
    properties: properties5,
    required: Object.keys(properties5)
  };
  // The schema cannot relate one field to another, so the dates are checked
  // against each other once each record is valid.
  async read(scan) {
    const events = await super.read(scan);
    for (const event of events) {
      const endsBeforeStart = event.endAt < event.startAt;
      const datesInconsistent = event.allDay ? event.startDate === null || event.endDate === null || event.endDate < event.startDate : event.startDate !== null || event.endDate !== null;
      if (endsBeforeStart || datesInconsistent)
        throw new TypeError("Calendar returned inconsistent event dates");
    }
    return events;
  }
  rows(scan) {
    return scan.events;
  }
  record({ eventId: eventId5, recurring, occurrence }) {
    const { allDay } = occurrence;
    return {
      id: eventId5,
      eventId: eventId5,
      calendarId: occurrence.calendarId,
      calendarItemId: occurrence.calendarItemId,
      externalId: occurrence.externalId ?? null,
      nativeEventId: occurrence.nativeEventId ?? null,
      name: occurrence.name ?? null,
      body: occurrence.body ?? null,
      location: occurrence.location ?? null,
      url: occurrence.url ?? null,
      startAt: timestamp(occurrence.startMs),
      endAt: timestamp(occurrence.endMs),
      allDay,
      startDate: allDay ? occurrence.startDay : null,
      endDate: allDay ? occurrence.endDay : null,
      timeZone: occurrence.timeZone ?? null,
      createdAt: timestamp(occurrence.createdMs),
      modifiedAt: timestamp(occurrence.modifiedMs),
      occurrenceAt: recurring ? timestamp(occurrence.occurrenceMs) : null,
      occurrenceDate: allDay && recurring ? occurrence.occurrenceDay ?? null : null,
      detached: occurrence.detached,
      status: occurrence.status,
      availability: occurrence.availability,
      birthdayContactId: occurrence.birthdayContactId ?? null,
      ...location(occurrence.place)
    };
  }
};

// packages/sources/apple/calendar/dist/streams/ics-attachments-stream.js
import { randomUUID } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
var { id: id7, icsItem, text: text5, nullableText: nullableText4, boolean: boolean5 } = calendarFields;
var properties6 = {
  id: {
    ...id7,
    description: "Same value as propertyId; the record key."
  },
  propertyId: {
    ...id7,
    description: "The ATTACH property; refers to icsProperties.id within this source."
  },
  componentId: {
    ...id7,
    description: "Component holding the ATTACH property; refers to icsComponents.id within this source."
  },
  ...icsItem,
  uri: {
    ...text5,
    description: "Raw ATTACH value: the base64 file content when inline is true, otherwise the attachment URI."
  },
  filename: {
    ...nullableText4,
    description: "First value of the ATTACH X-APPLE-FILENAME parameter, else of FILENAME; NULL when neither is present."
  },
  formatType: {
    ...nullableText4,
    description: "First value of the ATTACH FMTTYPE parameter, a media type; NULL when absent."
  },
  inline: {
    ...boolean5,
    description: "Whether ATTACH carries VALUE=BINARY or ENCODING=BASE64, so uri holds the file content itself rather than a location."
  }
};
var IcsAttachmentsStream = class extends CalendarStream {
  name = "icsAttachments";
  jsonSchema = {
    type: "object",
    description: "One source record per ATTACH property in the ICS export; the same property also remains in icsProperties with its parameters in icsParameters. File bytes can be inline (base64 in uri), remote (retrieved only by the attachment fetcher the app supplies) or unavailable: an attachment record exists even when no bytes are exported. Relationships name source streams, not destination tables.",
    properties: properties6,
    required: Object.keys(properties6)
  };
  supportsFileTransfer = true;
  requiresIcs = true;
  rows(scan) {
    return scan.ics.properties.filter(({ property }) => property.name === "ATTACH");
  }
  record({ item, componentId, id: id13, property }) {
    const parameter = (key) => property.parameters.find((candidate) => candidate.name === key)?.values[0] ?? null;
    return {
      id: id13,
      propertyId: id13,
      componentId,
      calendarId: item.calendarId,
      calendarItemId: item.calendarItemId,
      uri: property.value,
      filename: parameter("X-APPLE-FILENAME") ?? parameter("FILENAME"),
      formatType: parameter("FMTTYPE"),
      // RFC 5545 inline content: the value is the base64 file itself.
      inline: parameter("VALUE") === "BINARY" || parameter("ENCODING") === "BASE64"
    };
  }
  // An inline attachment carries its bytes; a remote one is retrieved by the
  // app's fetcher, which reports a file it cannot reach as missing.
  async file(attachment, scan, staging) {
    const extension = attachment.filename === null ? "" : extname(attachment.filename);
    const path = join(staging, `${randomUUID()}${extension}`);
    if (attachment.inline) {
      await writeFile(path, Buffer.from(attachment.uri, "base64"));
      return path;
    }
    const { uri, filename, formatType, calendarId, calendarItemId } = attachment;
    const fetched = await scan.fetch({ uri, filename, formatType, calendarId, calendarItemId }, path);
    if (!fetched)
      return null;
    if (!(await lstat(path)).isFile())
      throw new TypeError("The attachment fetcher did not write a regular file");
    return path;
  }
};

// packages/sources/apple/calendar/dist/streams/ics-components-stream.js
var { id: id8, icsItem: icsItem2, nullableText: nullableText5, ordinal: ordinal6, text: text6 } = calendarFields;
var properties7 = {
  id: {
    ...id8,
    description: 'JSON [calendarId, calendarItemId, path], where path lists child positions from the root VCALENDAR ("0", "0.1", \u2026).'
  },
  ...icsItem2,
  parentId: {
    ...nullableText5,
    description: "Enclosing component; refers to icsComponents.id within this source. NULL for the root VCALENDAR."
  },
  position: {
    ...ordinal6,
    description: "Order among sibling components, numbered in content order: EventKit's export order changes between reads."
  },
  name: {
    ...text6,
    description: "Component name as exported, uppercased, such as VCALENDAR, VEVENT or VALARM."
  },
  uid: {
    ...nullableText5,
    description: "Raw value of the component's UID property; NULL when it has none."
  },
  recurrenceId: {
    ...nullableText5,
    description: "Raw, unparsed value of the component's RECURRENCE-ID property, which marks a component overriding one occurrence of a series; NULL when absent."
  },
  recurrenceIdTimeZone: {
    ...nullableText5,
    description: "First TZID parameter value of RECURRENCE-ID; NULL when RECURRENCE-ID is absent or has no TZID."
  },
  eventId: {
    ...nullableText5,
    description: "events.eventId of the nonrecurring event this VEVENT exactly describes: set only for a VEVENT without RECURRENCE-ID of an item that has no recurrence rules and is not detached. NULL for every other component, including all components of a recurring item, which relate at (calendarId, calendarItemId)."
  }
};
var IcsComponentsStream = class extends CalendarStream {
  name = "icsComponents";
  jsonSchema = {
    type: "object",
    description: "One source record per iCalendar component in the private EventKit ICS export of each native item with an occurrence in the event window: the VCALENDAR root, the VEVENT master, exception VEVENTs carrying RECURRENCE-ID, their alarms and any other exported component. Each item is exported once and whole, so a recurring series can describe occurrences outside the window. Grain is the native item (calendarId, calendarItemId), not an occurrence: eventId is set only for a nonrecurring VEVENT. Joining recurring components to events on (calendarId, calendarItemId) repeats them once per occurrence, so aggregate occurrences before joining. The ICS streams are read only when one is selected; on a macOS without the private export the read fails instead of loading no rows. Relationships name source streams, not destination tables.",
    properties: properties7,
    required: Object.keys(properties7)
  };
  requiresIcs = true;
  rows(scan) {
    return scan.ics.components;
  }
  // RECURRENCE-ID stays raw with its TZID; eventId is set only where it is
  // exact: a non-recurring master.
  record({ item, id: id13, parentId, position, component }) {
    const { calendarId, calendarItemId } = item;
    const property = (name2) => component.properties.find((candidate) => candidate.name === name2);
    const recurrence = property("RECURRENCE-ID");
    return {
      id: id13,
      calendarId,
      calendarItemId,
      parentId,
      position,
      name: component.name,
      uid: property("UID")?.value ?? null,
      recurrenceId: recurrence?.value ?? null,
      recurrenceIdTimeZone: recurrence?.parameters.find((parameter) => parameter.name === "TZID")?.values[0] ?? null,
      eventId: component.name === "VEVENT" && !item.recurring && !recurrence ? JSON.stringify([calendarId, calendarItemId, null]) : null
    };
  }
};

// packages/sources/apple/calendar/dist/streams/ics-parameters-stream.js
var { id: id9, icsItem: icsItem3, ordinal: ordinal7, text: text7 } = calendarFields;
var properties8 = {
  id: {
    ...id9,
    description: "JSON [calendarId, calendarItemId, path, propertyPosition, position, valuePosition], extending the property id."
  },
  propertyId: {
    ...id9,
    description: "Owning property; refers to icsProperties.id within this source."
  },
  componentId: {
    ...id9,
    description: "Component of the owning property; refers to icsComponents.id within this source."
  },
  ...icsItem3,
  position: {
    ...ordinal7,
    description: "Index of the parameter within its property, in export order."
  },
  valuePosition: {
    ...ordinal7,
    description: "Index of this value within the parameter."
  },
  name: {
    ...text7,
    description: "Parameter name as exported, uppercased."
  },
  value: {
    ...text7,
    description: "One parameter value, with surrounding double quotes removed and RFC 6868 caret escapes (^n, ^', ^^) decoded; otherwise as exported."
  }
};
var IcsParametersStream = class extends CalendarStream {
  name = "icsParameters";
  jsonSchema = {
    type: "object",
    description: "One source record per value of each iCalendar property parameter: a comma-separated multi-value parameter yields one record per value. Relationships name source streams, not destination tables.",
    properties: properties8,
    required: Object.keys(properties8)
  };
  requiresIcs = true;
  rows(scan) {
    return scan.ics.properties.flatMap((line) => line.property.parameters.flatMap(({ name: name2, values }, position) => values.map((value, valuePosition) => ({
      line,
      position,
      valuePosition,
      name: name2,
      value
    }))));
  }
  record({ line, position, valuePosition, name: name2, value }) {
    return {
      id: JSON.stringify([...line.key, position, valuePosition]),
      propertyId: line.id,
      componentId: line.componentId,
      calendarId: line.item.calendarId,
      calendarItemId: line.item.calendarItemId,
      position,
      valuePosition,
      name: name2,
      value
    };
  }
};

// packages/sources/apple/calendar/dist/streams/ics-properties-stream.js
var { id: id10, icsItem: icsItem4, ordinal: ordinal8, text: text8 } = calendarFields;
var properties9 = {
  id: {
    ...id10,
    description: "JSON [calendarId, calendarItemId, path, position], extending the component path; icsParameters.propertyId and icsAttachments.propertyId refer to it."
  },
  componentId: {
    ...id10,
    description: "Owning component; refers to icsComponents.id within this source."
  },
  ...icsItem4,
  position: {
    ...ordinal8,
    description: "Index among the component's properties in export order, counted after DTSTAMP is removed."
  },
  name: {
    ...text8,
    description: "Property name as exported, uppercased, including vendor X- names."
  },
  value: {
    ...text8,
    description: "Raw property value as exported after line unfolding: no TEXT unescaping, date parsing or decoding. An inline ATTACH value is a whole base64 file."
  }
};
var IcsPropertiesStream = class extends CalendarStream {
  name = "icsProperties";
  jsonSchema = {
    type: "object",
    description: "One source record per property line of an icsComponents component, in export order, except DTSTAMP: EventKit sets it to the export time, so it is omitted. Values are raw iCalendar text; vendor X- properties are kept. ATTACH properties also appear in icsAttachments. Relationships name source streams, not destination tables.",
    properties: properties9,
    required: Object.keys(properties9)
  };
  requiresIcs = true;
  rows(scan) {
    return scan.ics.properties;
  }
  record({ item, componentId, id: id13, position, property }) {
    return {
      id: id13,
      componentId,
      calendarId: item.calendarId,
      calendarItemId: item.calendarItemId,
      position,
      name: property.name,
      value: property.value
    };
  }
};

// packages/sources/apple/calendar/dist/streams/recurrence-rule-values-stream.js
var { id: id11, eventId: eventId3, text: text9, ordinal: ordinal9, integer: integer2 } = calendarFields;
var properties10 = {
  id: {
    ...id11,
    description: "JSON [ruleId, component, position]; unique within this stream."
  },
  eventId: eventId3,
  ruleId: {
    ...id11,
    description: "Owning rule; refers to recurrenceRules.id within this source."
  },
  component: {
    ...text9,
    description: "The EventKit EKRecurrenceRule list property this value belongs to: daysOfTheWeek (iCalendar BYDAY), daysOfTheMonth (BYMONTHDAY), daysOfTheYear (BYYEARDAY), weeksOfTheYear (BYWEEKNO), monthsOfTheYear (BYMONTH) or setPositions (BYSETPOS)."
  },
  position: {
    ...ordinal9,
    description: "Index in that EventKit list, in the order EventKit returns it."
  },
  value: {
    ...integer2,
    description: "For daysOfTheWeek, EKRecurrenceDayOfWeek.dayOfTheWeek (EKWeekday): 1 Sunday through 7 Saturday. Otherwise the list entry; negative values count from the end of the month or year (setPositions: from the end of the set)."
  },
  weekNumber: {
    type: ["integer", "null"],
    description: "For daysOfTheWeek, EventKit EKRecurrenceDayOfWeek.weekNumber, which Apple's plain dayOfWeek: constructor sets to 0; NULL for every other component."
  }
};
var numberLists = [
  "daysOfTheMonth",
  "daysOfTheYear",
  "weeksOfTheYear",
  "monthsOfTheYear",
  "setPositions"
];
var RecurrenceRuleValuesStream = class extends CalendarStream {
  name = "recurrenceRuleValues";
  jsonSchema = {
    type: "object",
    description: `One source record per entry of a recurrence rule's day, week, month or set-position lists. ${perOccurrence} ruleId refers to recurrenceRules.id and eventId to events.eventId. Relationships name source streams, not destination tables.`,
    properties: properties10,
    required: Object.keys(properties10)
  };
  rows(scan) {
    return scan.rules.flatMap(({ eventId: eventId5, ruleId, rule }) => [
      ...rule.daysOfTheWeek.map((day, position) => ({
        eventId: eventId5,
        ruleId,
        component: "daysOfTheWeek",
        position,
        value: day.day,
        weekNumber: day.weekNumber
      })),
      ...numberLists.flatMap((component) => rule[component].map((value, position) => ({
        eventId: eventId5,
        ruleId,
        component,
        position,
        value,
        weekNumber: null
      })))
    ]);
  }
  record(row) {
    return {
      id: JSON.stringify([row.ruleId, row.component, row.position]),
      eventId: row.eventId,
      ruleId: row.ruleId,
      component: row.component,
      position: row.position,
      value: row.value,
      weekNumber: row.weekNumber
    };
  }
};

// packages/sources/apple/calendar/dist/streams/recurrence-rules-stream.js
var { id: id12, eventId: eventId4, ordinal: ordinal10, text: text10, integer: integer3, nullableTimestamp: nullableTimestamp3 } = calendarFields;
var properties11 = {
  id: {
    ...id12,
    description: 'JSON [eventId, "recurrenceRule", position]; recurrenceRuleValues.ruleId refers to it.'
  },
  eventId: eventId4,
  position: {
    ...ordinal10,
    description: "Index in EventKit EKCalendarItem.recurrenceRules, in the order EventKit returns them."
  },
  calendarIdentifier: {
    ...text10,
    description: "EventKit EKRecurrenceRule.calendarIdentifier: the calendar system the rule uses."
  },
  frequency: {
    ...ordinal10,
    description: "EventKit EKRecurrenceRule.frequency raw value (EKRecurrenceFrequency): 0 daily, 1 weekly, 2 monthly, 3 yearly. Unknown codes are kept as numbers."
  },
  interval: {
    ...integer3,
    minimum: 1,
    description: "EventKit EKRecurrenceRule.interval: the rule repeats every interval frequency units, such as 2 with weekly for every other week."
  },
  firstDayOfWeek: {
    ...integer3,
    minimum: 0,
    maximum: 7,
    description: "EventKit EKRecurrenceRule.firstDayOfTheWeek: 1 Sunday through 7 Saturday; 0 when the rule does not set it."
  },
  endAt: {
    ...nullableTimestamp3,
    description: "EventKit EKRecurrenceRule.recurrenceEnd.endDate as a UTC timestamp; NULL when the rule ends after a count or never ends."
  },
  occurrenceCount: {
    ...ordinal10,
    description: "EventKit EKRecurrenceRule.recurrenceEnd.occurrenceCount; 0 when the rule ends at endAt or never ends. endAt NULL with 0 here means no end."
  }
};
var RecurrenceRulesStream = class extends CalendarStream {
  name = "recurrenceRules";
  jsonSchema = {
    type: "object",
    description: `One source record per EventKit recurrence rule of a recurring event occurrence. ${perOccurrence} eventId refers to events.eventId; recurrenceRuleValues holds each rule's list values. Relationships name source streams, not destination tables.`,
    properties: properties11,
    required: Object.keys(properties11)
  };
  rows(scan) {
    return scan.rules;
  }
  record({ eventId: eventId5, ruleId, position, rule }) {
    return {
      id: ruleId,
      eventId: eventId5,
      position,
      calendarIdentifier: rule.calendarIdentifier ?? null,
      frequency: rule.frequency,
      interval: rule.interval,
      firstDayOfWeek: rule.firstDayOfWeek,
      endAt: timestamp(rule.end?.endMs),
      occurrenceCount: rule.end?.occurrenceCount ?? 0
    };
  }
};

// packages/sources/apple/calendar/dist/apple-calendar-source.js
var CalendarIcsUnavailableError = class extends Error {
  name = "CalendarIcsUnavailableError";
  constructor(cause) {
    super("This macOS version does not provide the private EventKit ICS export that the Calendar ICS streams read. Select the other Calendar streams, which use public EventKit.", { cause });
  }
};
var readers = {
  accounts: new AccountsStream(),
  calendars: new CalendarsStream(),
  events: new EventsStream(),
  icsComponents: new IcsComponentsStream(),
  icsProperties: new IcsPropertiesStream(),
  icsAttachments: new IcsAttachmentsStream(),
  icsParameters: new IcsParametersStream(),
  attendees: new AttendeesStream(),
  alarms: new AlarmsStream(),
  recurrenceRules: new RecurrenceRulesStream(),
  recurrenceRuleValues: new RecurrenceRuleValuesStream()
};
var catalog = new Catalog(Object.values(readers).map((reader) => reader.describe()));
var readersByName = new Map(Object.values(readers).map((reader) => [reader.name, reader]));
var readerOf = (stream) => {
  const reader = readersByName.get(stream.name);
  if (reader === void 0)
    throw new Error(`Apple Calendar has no stream ${stream.name}`);
  return reader;
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
  accounts = readers.accounts.describe();
  calendars = readers.calendars.describe();
  events = readers.events.describe();
  attendees = readers.attendees.describe();
  alarms = readers.alarms.describe();
  recurrenceRules = readers.recurrenceRules.describe();
  recurrenceRuleValues = readers.recurrenceRuleValues.describe();
  icsComponents = readers.icsComponents.describe();
  icsProperties = readers.icsProperties.describe();
  icsParameters = readers.icsParameters.describe();
  icsAttachments = readers.icsAttachments.describe();
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
    if (!readerOf(stream).dated)
      return {
        description: "All Calendar accounts or calendars visible through EventKit on this Mac. No date filter; the event window does not restrict these listings.",
        selection: this.scope
      };
    return {
      description: "EventKit event occurrences overlapping the configured UTC interval [startAt, endAt); zero-duration events must start within it. Related rows and ICS exports belong to those selected events; ICS may describe a recurring series beyond the interval. Only calendars visible on this Mac are included. This is a requested window, not observed event dates. Attachment metadata may exist without retrievable file bytes.",
      selection: { ...this.scope, startAt: this.startAt, endAt: this.endAt }
    };
  }
  async *observe({ streams, signal }) {
    for await (const _ of this.#store.watch(signal))
      yield streams;
  }
  // Every selected stream reads from one change-free EventKit read, so
  // occurrences match their calendars and ICS rows their items. The private
  // ICS export is asked for only when an ICS stream is selected.
  async open(streams) {
    try {
      const contents = await this.#store.read({
        startAt: this.startAt,
        endAt: this.endAt,
        ics: streams.some((stream) => readerOf(stream).requiresIcs),
        accountIds: this.scope.accountIds,
        calendarIds: this.scope.collectionIds
      });
      return new CalendarScan(contents, this.#attachments);
    } catch (error) {
      if (error instanceof IcsExportUnavailableError)
        throw new CalendarIcsUnavailableError(error);
      throw error;
    }
  }
  async *extract(configuration, state, _partition, scan) {
    var _stack = [];
    try {
      const { stream } = configuration;
      const reader = readerOf(stream);
      const records = await reader.read(scan);
      const messages = configuration.syncMode === "incremental" ? diffSnapshot(stream, records, state) : records.map((data) => ({ stream: stream.name, data }));
      if (configuration.fileReads.length === 0) {
        yield* messages;
        return;
      }
      const staging = __using(_stack, await mkdtempDisposable(join2(tmpdir(), "context-compiler-calendar-attachment-")), true);
      for await (const message of messages) {
        if ("type" in message) {
          yield message;
          continue;
        }
        const file = await reader.file(message.data, scan, staging.path);
        yield { ...message, file };
        if (file !== null)
          await rm(file, { force: true });
      }
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      var _promise = __callDispose(_stack, _error, _hasError);
      _promise && await _promise;
    }
  }
};

// packages/connectors/apple/calendar/dist/calendar-connector.js
var CalendarConnector = class extends AppleConnector {
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
  CalendarConnector as default
};
