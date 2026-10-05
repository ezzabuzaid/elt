import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  RemindersStore
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
  localAppleStoreCoverage
} from "../../chunks/chunk-BRJ4TKR5.mjs";
import {
  AppleConnector
} from "../../chunks/chunk-7XFLCHNF.mjs";
import {
  Catalog,
  Source,
  Stream,
  diffSnapshot,
  validateRecords
} from "../../chunks/chunk-C5AZWDBZ.mjs";
import "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/sources/apple/reminders/dist/reminders-scan.js
var timestamp = (ms) => ms === void 0 ? null : new Date(ms).toISOString();
var RemindersScan = class {
  accounts;
  // Reminder lists, which EventKit calls calendars.
  lists;
  reminders;
  #rules;
  constructor({ accounts: accounts2, calendars, reminders }) {
    this.accounts = accounts2;
    this.lists = calendars;
    this.reminders = reminders;
  }
  // Each recurrence rule with the id its values refer to, built once for
  // both rule streams.
  get rules() {
    this.#rules ??= this.reminders.flatMap((reminder) => reminder.recurrenceRules.map((rule, position) => ({
      reminderId: reminder.id,
      ruleId: JSON.stringify([reminder.id, "recurrenceRule", position]),
      position,
      rule
    })));
    return this.#rules;
  }
  async [Symbol.asyncDispose]() {
  }
};

// packages/sources/apple/reminders/dist/apple-reminders-stream.js
var remindersFields = {
  ...eventKitFields,
  reminderId: {
    ...eventKitFields.id,
    description: "Owning reminder; refers to reminders.id within this source."
  }
};
var AppleRemindersStream = class {
  primaryKey = ["id"];
  supportedSyncModes = Object.freeze([
    "full_refresh",
    "incremental"
  ]);
  // Every read is the whole store, so incremental copies diff snapshots.
  sourceDefinedCursor = true;
  emitsDeletes = true;
  #stream;
  describe() {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }
  read(scan) {
    return validateRecords(this, this.rows(scan).map((row) => this.record(row)), "EventKit");
  }
};

// packages/sources/apple/reminders/dist/streams/accounts-stream.js
var { id, text, ordinal, boolean } = remindersFields;
var properties = {
  id: {
    ...id,
    description: "EventKit EKSource.sourceIdentifier; accountId of the lists stream within this source refers to it."
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
var AccountsStream = class extends AppleRemindersStream {
  name = "accounts";
  jsonSchema = {
    type: "object",
    description: "One source record per EventKit account (EKSource) in this Mac's store, including accounts without reminder lists. An import scope keeps the selected accounts; a list scope also drops accounts owning no selected list. Relationships name source streams, not destination tables.",
    properties,
    required: Object.keys(properties)
  };
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

// packages/sources/apple/reminders/dist/streams/alarms-stream.js
var { id: id2, nullableText, ordinal: ordinal2, number, nullableTimestamp, location, reminderId } = remindersFields;
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
function place(structured) {
  return {
    locationTitle: structured?.title ?? null,
    latitude: structured?.latitude ?? null,
    longitude: structured?.longitude ?? null,
    radius: structured?.radius ?? null
  };
}
var properties2 = {
  id: {
    ...id2,
    description: "JSON [reminderId, position]; unique within this stream."
  },
  reminderId,
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
    description: "EventKit EKAlarm.relativeOffset in seconds. Apple documents it relative to an event start; which reminder date anchors it is not documented, so it is kept unconverted. Apple documents an alarm as either relative or absolute, so it is not the trigger when absoluteAt is set."
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
var AlarmsStream = class extends AppleRemindersStream {
  name = "alarms";
  jsonSchema = {
    type: "object",
    description: "One source record per EventKit alarm of a reminder, whether it fires at a time or at a location. reminderId refers to reminders.id. Relationships name source streams, not destination tables.",
    properties: properties2,
    required: Object.keys(properties2)
  };
  rows(scan) {
    return scan.reminders.flatMap((reminder) => reminder.alarms.map((alarm, position) => ({
      reminderId: reminder.id,
      alarm,
      position
    })));
  }
  record({ reminderId: reminderId6, alarm, position }) {
    return {
      id: JSON.stringify([reminderId6, position]),
      reminderId: reminderId6,
      position,
      type: alarm.alarmType,
      relativeOffset: alarm.relativeOffset,
      absoluteAt: timestamp(alarm.absoluteMs),
      emailAddress: alarm.emailAddress ?? null,
      soundName: alarm.soundName ?? null,
      proximity: alarm.proximity,
      ...place(alarm.location)
    };
  }
};

// packages/sources/apple/reminders/dist/streams/attendees-stream.js
var { id: id3, text: text2, ordinal: ordinal3, nullableText: nullableText2, boolean: boolean2, reminderId: reminderId2 } = remindersFields;
var properties3 = {
  id: {
    ...id3,
    description: "JSON [reminderId, kind, position]; unique within this stream."
  },
  reminderId: reminderId2,
  position: {
    ...ordinal3,
    description: "Order among the owner's participants of the same kind. Attendees are numbered in content order (URL, name, role, type), not EventKit's order, which changes between reads."
  },
  kind: {
    ...text2,
    description: "Always 'attendee': an entry of EventKit EKCalendarItem.attendees. Reminders read no organizer."
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
var AttendeesStream = class extends AppleRemindersStream {
  name = "attendees";
  jsonSchema = {
    type: "object",
    description: "One source record per attendee EventKit lists for a reminder. reminderId refers to reminders.id. Relationships name source streams, not destination tables.",
    properties: properties3,
    required: Object.keys(properties3)
  };
  rows(scan) {
    return scan.reminders.flatMap((reminder) => reminder.attendees.map((attendee, position) => ({
      reminderId: reminder.id,
      attendee,
      position
    })));
  }
  record({ reminderId: reminderId6, attendee, position }) {
    return {
      id: JSON.stringify([reminderId6, "attendee", position]),
      reminderId: reminderId6,
      position,
      kind: "attendee",
      name: attendee.name ?? null,
      url: attendee.url,
      status: attendee.status,
      role: attendee.role,
      type: attendee.participantType,
      isCurrentUser: attendee.isCurrentUser
    };
  }
};

// packages/sources/apple/reminders/dist/streams/date-components-stream.js
var { id: id4, text: text3, nullableText: nullableText3, boolean: boolean3, reminderId: reminderId3 } = remindersFields;
var dateComponentNames = [
  "era",
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second",
  "nanosecond",
  "weekday",
  "weekdayOrdinal",
  "quarter",
  "weekOfMonth",
  "weekOfYear",
  "yearForWeekOfYear",
  "dayOfYear"
];
var properties4 = {
  id: {
    ...id4,
    description: "JSON [reminderId, kind]; unique within this stream."
  },
  reminderId: reminderId3,
  kind: {
    ...text3,
    enum: ["start", "due"],
    description: "start for EventKit EKReminder.startDateComponents, due for EKReminder.dueDateComponents."
  },
  calendarIdentifier: {
    ...nullableText3,
    description: "Identifier of the NSDateComponents calendar, the calendar system the components count in; NULL when the set has no calendar."
  },
  timeZone: {
    ...nullableText3,
    description: "NSDateComponents.timeZone identifier; NULL for a floating date, which Apple documents as a nil time zone."
  },
  ...Object.fromEntries(dateComponentNames.map((name2) => [
    name2,
    {
      type: ["integer", "null"],
      description: `NSDateComponents.${name2}; NULL when the set leaves it undefined or this macOS does not provide it.`
    }
  ])),
  leapMonth: {
    ...boolean3,
    description: "NSDateComponents.isLeapMonth: whether month is a leap month in the set's calendar."
  },
  repeatedDay: {
    ...boolean3,
    description: "NSDateComponents.isRepeatedDay: whether day is a repeated day in the set's calendar."
  }
};
var DateComponentsStream = class extends AppleRemindersStream {
  name = "dateComponents";
  jsonSchema = {
    type: "object",
    description: "One source record per start or due date a reminder sets; a reminder without that date has no record. Each record keeps EventKit's NSDateComponents set whole: calendar, time zone, leap month and every component, with a missing component NULL and no manufactured UTC timestamp. A date without a time has NULL hour, minute and second. reminderId refers to reminders.id. Relationships name source streams, not destination tables.",
    properties: properties4,
    required: Object.keys(properties4)
  };
  rows(scan) {
    return scan.reminders.flatMap((reminder) => ["start", "due"].flatMap((kind) => {
      const components = reminder[kind];
      return components === void 0 ? [] : [{ reminderId: reminder.id, kind, components }];
    }));
  }
  // One start or due component set, kept whole: a missing component stays null
  // instead of becoming a manufactured date.
  record({ reminderId: reminderId6, kind, components }) {
    return {
      id: JSON.stringify([reminderId6, kind]),
      reminderId: reminderId6,
      kind,
      calendarIdentifier: components.calendarIdentifier ?? null,
      timeZone: components.timeZone ?? null,
      ...Object.fromEntries(dateComponentNames.map((name2) => [name2, components[name2] ?? null])),
      leapMonth: components.leapMonth,
      repeatedDay: components.repeatedDay
    };
  }
};

// packages/sources/apple/reminders/dist/streams/lists-stream.js
var { id: id5, text: text4, ordinal: ordinal4, boolean: boolean4 } = remindersFields;
var color = { type: ["number", "null"], minimum: 0, maximum: 1 };
var properties5 = {
  id: {
    ...id5,
    description: "EventKit EKCalendar.calendarIdentifier. Apple documents that a full sync can replace it, so it is not a stable identity."
  },
  accountId: {
    ...id5,
    description: "EventKit EKCalendar.source.sourceIdentifier: the owning account; refers to accounts.id within this source."
  },
  name: { ...text4, description: "EventKit EKCalendar.title." },
  type: {
    ...ordinal4,
    description: "EventKit EKCalendar.type raw value (EKCalendarType): 0 local, 1 CalDAV, 2 Exchange, 3 subscription, 4 birthday. Apple reports a subscribed CalDAV calendar as 1 with subscribed true. Unknown codes are kept as numbers."
  },
  writable: {
    ...boolean4,
    description: "EventKit EKCalendar.allowsContentModifications: whether items can be added, removed or modified in it."
  },
  subscribed: { ...boolean4, description: "EventKit EKCalendar.isSubscribed." },
  immutable: {
    ...boolean4,
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
  }
};
var ListsStream = class extends AppleRemindersStream {
  name = "lists";
  jsonSchema = {
    type: "object",
    description: "One source record per reminder list (an EventKit calendar for reminders) visible on this Mac. An import scope keeps only the selected lists. accountId refers to accounts.id; reminders.listId refers to id. Relationships name source streams, not destination tables.",
    properties: properties5,
    required: Object.keys(properties5)
  };
  rows(scan) {
    return scan.lists;
  }
  record(list) {
    return {
      id: list.id,
      accountId: list.accountId ?? null,
      name: list.name,
      type: list.calendarType,
      writable: list.writable,
      subscribed: list.subscribed,
      immutable: list.immutable,
      colorRed: list.color?.[0] ?? null,
      colorGreen: list.color?.[1] ?? null,
      colorBlue: list.color?.[2] ?? null,
      colorAlpha: list.color?.[3] ?? null,
      supportedAvailabilities: list.supportedAvailabilities,
      allowedEntityTypes: list.allowedEntityTypes
    };
  }
};

// packages/sources/apple/reminders/dist/streams/recurrence-rule-values-stream.js
var { id: id6, text: text5, ordinal: ordinal5, integer, reminderId: reminderId4 } = remindersFields;
var numberLists = [
  "daysOfTheMonth",
  "daysOfTheYear",
  "weeksOfTheYear",
  "monthsOfTheYear",
  "setPositions"
];
var properties6 = {
  id: {
    ...id6,
    description: "JSON [ruleId, component, position]; unique within this stream."
  },
  reminderId: reminderId4,
  ruleId: {
    ...id6,
    description: "Owning rule; refers to recurrenceRules.id within this source."
  },
  component: {
    ...text5,
    description: "The EventKit EKRecurrenceRule list property this value belongs to: daysOfTheWeek (iCalendar BYDAY), daysOfTheMonth (BYMONTHDAY), daysOfTheYear (BYYEARDAY), weeksOfTheYear (BYWEEKNO), monthsOfTheYear (BYMONTH) or setPositions (BYSETPOS)."
  },
  position: {
    ...ordinal5,
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
var RecurrenceRuleValuesStream = class extends AppleRemindersStream {
  name = "recurrenceRuleValues";
  jsonSchema = {
    type: "object",
    description: "One source record per entry of a recurrence rule's day, week, month or set-position lists. ruleId refers to recurrenceRules.id and reminderId to reminders.id. Relationships name source streams, not destination tables.",
    properties: properties6,
    required: Object.keys(properties6)
  };
  rows(scan) {
    return scan.rules.flatMap(({ reminderId: reminderId6, ruleId, rule }) => [
      ...rule.daysOfTheWeek.map((day, position) => ({
        reminderId: reminderId6,
        ruleId,
        component: "daysOfTheWeek",
        position,
        value: day.day,
        weekNumber: day.weekNumber
      })),
      ...numberLists.flatMap((component) => rule[component].map((value, position) => ({
        reminderId: reminderId6,
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
      reminderId: row.reminderId,
      ruleId: row.ruleId,
      component: row.component,
      position: row.position,
      value: row.value,
      weekNumber: row.weekNumber
    };
  }
};

// packages/sources/apple/reminders/dist/streams/recurrence-rules-stream.js
var { id: id7, text: text6, ordinal: ordinal6, integer: integer2, nullableTimestamp: nullableTimestamp2, reminderId: reminderId5 } = remindersFields;
var properties7 = {
  id: {
    ...id7,
    description: 'JSON [reminderId, "recurrenceRule", position]; recurrenceRuleValues.ruleId refers to it.'
  },
  reminderId: reminderId5,
  position: {
    ...ordinal6,
    description: "Index in EventKit EKCalendarItem.recurrenceRules, in the order EventKit returns them."
  },
  calendarIdentifier: {
    ...text6,
    description: "EventKit EKRecurrenceRule.calendarIdentifier: the calendar system the rule uses."
  },
  frequency: {
    ...ordinal6,
    description: "EventKit EKRecurrenceRule.frequency raw value (EKRecurrenceFrequency): 0 daily, 1 weekly, 2 monthly, 3 yearly. Unknown codes are kept as numbers."
  },
  interval: {
    ...integer2,
    minimum: 1,
    description: "EventKit EKRecurrenceRule.interval: the rule repeats every interval frequency units, such as 2 with weekly for every other week."
  },
  firstDayOfWeek: {
    ...integer2,
    minimum: 0,
    maximum: 7,
    description: "EventKit EKRecurrenceRule.firstDayOfTheWeek: 1 Sunday through 7 Saturday; 0 when the rule does not set it."
  },
  endAt: {
    ...nullableTimestamp2,
    description: "EventKit EKRecurrenceRule.recurrenceEnd.endDate as a UTC timestamp; NULL when the rule ends after a count or never ends."
  },
  occurrenceCount: {
    ...ordinal6,
    description: "EventKit EKRecurrenceRule.recurrenceEnd.occurrenceCount; 0 when the rule ends at endAt or never ends. endAt NULL with 0 here means no end."
  }
};
var RecurrenceRulesStream = class extends AppleRemindersStream {
  name = "recurrenceRules";
  jsonSchema = {
    type: "object",
    description: "One source record per EventKit recurrence rule of a reminder. reminderId refers to reminders.id; recurrenceRuleValues holds each rule's list values. Relationships name source streams, not destination tables.",
    properties: properties7,
    required: Object.keys(properties7)
  };
  rows(scan) {
    return scan.rules;
  }
  record({ reminderId: reminderId6, ruleId, position, rule }) {
    return {
      id: ruleId,
      reminderId: reminderId6,
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

// packages/sources/apple/reminders/dist/streams/reminders-stream.js
var { id: id8, text: text7, nullableText: nullableText4, nullableTimestamp: nullableTimestamp3, integer: integer3, boolean: boolean5 } = remindersFields;
var properties8 = {
  id: {
    ...id8,
    description: "EventKit EKCalendarItem.calendarItemIdentifier; related streams refer to it through reminderId. Apple documents that a full sync can replace it."
  },
  listId: {
    ...id8,
    description: "EventKit EKCalendarItem.calendar.calendarIdentifier: the owning list; refers to lists.id within this source."
  },
  externalId: {
    ...nullableText4,
    description: "EventKit EKCalendarItem.calendarItemExternalIdentifier, the server-provided identifier; NULL when EventKit has none. Apple documents duplicates across calendars and, for Exchange reminders, different values between devices, so it is not unique."
  },
  name: { ...text7, description: "EventKit EKCalendarItem.title." },
  body: {
    ...nullableText4,
    description: "EventKit EKCalendarItem.notes; NULL when unset."
  },
  location: {
    ...nullableText4,
    description: "EventKit EKCalendarItem.location; NULL when unset."
  },
  url: {
    ...nullableText4,
    description: "EventKit EKCalendarItem.URL as a string; NULL when unset."
  },
  timeZone: {
    ...nullableText4,
    description: "EventKit EKCalendarItem.timeZone identifier; NULL when EventKit has none, which Apple documents as floating. The start and due component sets carry their own time zones in dateComponents."
  },
  createdAt: {
    ...nullableTimestamp3,
    description: "EventKit EKCalendarItem.creationDate as a UTC timestamp; NULL when EventKit has none."
  },
  modifiedAt: {
    ...nullableTimestamp3,
    description: "EventKit EKCalendarItem.lastModifiedDate as a UTC timestamp; NULL when EventKit has none."
  },
  completed: {
    ...boolean5,
    description: "EventKit EKReminder.isCompleted."
  },
  completedAt: {
    ...nullableTimestamp3,
    description: "EventKit EKReminder.completionDate as a UTC timestamp; NULL when EventKit has none."
  },
  priority: {
    ...integer3,
    minimum: 0,
    maximum: 9,
    description: "EventKit EKReminder.priority: 0 no priority, 1 highest through 9 lowest. Apple follows RFC 5545 (1 to 4 high, 5 medium, 6 to 9 low); its EKReminderPriority constants are 1 high, 5 medium and 9 low."
  }
};
var RemindersStream = class extends AppleRemindersStream {
  name = "reminders";
  jsonSchema = {
    type: "object",
    description: "One source record per reminder visible through EventKit on this Mac, completed reminders included, limited to the selected lists when an import scope is set. No date filter. Start and due dates live in dateComponents as native component sets; no UTC due timestamp is derived. dateComponents, attendees, alarms, recurrenceRules and recurrenceRuleValues refer to id through reminderId; listId refers to lists.id. Relationships name source streams, not destination tables.",
    properties: properties8,
    required: Object.keys(properties8)
  };
  rows(scan) {
    return scan.reminders;
  }
  record(reminder) {
    return {
      id: reminder.id,
      listId: reminder.listId,
      externalId: reminder.externalId ?? null,
      name: reminder.name ?? null,
      body: reminder.body ?? null,
      location: reminder.location ?? null,
      url: reminder.url ?? null,
      timeZone: reminder.timeZone ?? null,
      createdAt: timestamp(reminder.createdMs),
      modifiedAt: timestamp(reminder.modifiedMs),
      completed: reminder.completed,
      completedAt: timestamp(reminder.completedMs),
      priority: reminder.priority
    };
  }
};

// packages/sources/apple/reminders/dist/apple-reminders-source.js
var readers = {
  accounts: new AccountsStream(),
  lists: new ListsStream(),
  reminders: new RemindersStream(),
  dateComponents: new DateComponentsStream(),
  attendees: new AttendeesStream(),
  alarms: new AlarmsStream(),
  recurrenceRules: new RecurrenceRulesStream(),
  recurrenceRuleValues: new RecurrenceRuleValuesStream()
};
var catalog = new Catalog(Object.values(readers).map((reader) => reader.describe()));
var readersByName = new Map(Object.values(readers).map((reader) => [reader.name, reader]));
var AppleRemindersSource = class extends Source {
  #store;
  identity = "apple-reminders:eventkit";
  catalog = catalog;
  accounts = readers.accounts.describe();
  lists = readers.lists.describe();
  reminders = readers.reminders.describe();
  dateComponents = readers.dateComponents.describe();
  attendees = readers.attendees.describe();
  alarms = readers.alarms.describe();
  recurrenceRules = readers.recurrenceRules.describe();
  recurrenceRuleValues = readers.recurrenceRuleValues.describe();
  scope;
  constructor({ store, scope = {} }) {
    super();
    this.#store = store;
    this.scope = scope;
    Object.freeze(this);
  }
  coverage(_stream) {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }
  async *observe({ streams, signal }) {
    for await (const _ of this.#store.watch(signal))
      yield streams;
  }
  // One change-free read for every selected stream, so reminders match their
  // lists and alarms their reminders.
  async open() {
    return new RemindersScan(await this.#store.read({
      accountIds: this.scope.accountIds,
      calendarIds: this.scope.collectionIds
    }));
  }
  async *extract({ stream, syncMode }, state, _partition, scan) {
    const reader = readersByName.get(stream.name);
    if (reader === void 0)
      throw new Error(`Apple Reminders has no stream ${stream.name}`);
    const records = reader.read(scan);
    if (syncMode === "incremental")
      yield* diffSnapshot(stream, records, state);
    else
      for (const data of records)
        yield { stream: stream.name, data };
  }
};

// packages/connectors/apple/reminders/dist/reminders-connector.js
var RemindersConnector = class extends AppleConnector {
  datedBy = null;
  fullDiskAccess = false;
  choices = [
    accounts(name),
    collections("lists", "lists")
  ];
  unscoped = [];
  storeCopies = [];
  access(grantee) {
    return `Allow ${grantee} full Reminders access when macOS asks, or in System Settings \u203A Privacy & Security \u203A Reminders.`;
  }
  source(scope) {
    return new AppleRemindersSource({
      store: new RemindersStore(this.host.eventKitHelper),
      scope
    });
  }
};
export {
  RemindersConnector as default
};
