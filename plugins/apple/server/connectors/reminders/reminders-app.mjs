import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  RemindersStore
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
  localAppleStoreCoverage
} from "../../chunks/chunk-BRJ4TKR5.mjs";
import {
  AppleApp
} from "../../chunks/chunk-DZDPSHJB.mjs";
import {
  Catalog,
  Source,
  Stream,
  diffSnapshot,
  validateRecords
} from "../../chunks/chunk-OEQ4WCEQ.mjs";
import "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/sources/apple/reminders/dist/reminder-rows.js
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
function reminderRows(contents) {
  const related = contents.reminders.map(relatedRows);
  return /* @__PURE__ */ new Map([
    ["accounts", contents.accounts.map(accountRow)],
    ["lists", contents.calendars.map(listRow)],
    ["reminders", contents.reminders.map(reminderRow)],
    [
      "dateComponents",
      contents.reminders.flatMap((reminder) => ["start", "due"].flatMap((kind) => {
        const components = reminder[kind];
        return components === void 0 ? [] : [dateComponentsRow(reminder.id, kind, components)];
      }))
    ],
    ["attendees", related.flatMap((rows) => rows.attendees)],
    ["alarms", related.flatMap((rows) => rows.alarms)],
    ["recurrenceRules", related.flatMap((rows) => rows.recurrenceRules)],
    [
      "recurrenceRuleValues",
      related.flatMap((rows) => rows.recurrenceRuleValues)
    ]
  ]);
}
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
function accountRow(account) {
  return {
    id: account.id,
    name: account.name,
    type: account.sourceType,
    isDelegate: account.isDelegate
  };
}
function listRow(list) {
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
function reminderRow(reminder) {
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
function dateComponentsRow(reminderId2, kind, components) {
  return {
    id: JSON.stringify([reminderId2, kind]),
    reminderId: reminderId2,
    kind,
    calendarIdentifier: components.calendarIdentifier ?? null,
    timeZone: components.timeZone ?? null,
    ...Object.fromEntries(dateComponentNames.map((name2) => [name2, components[name2] ?? null])),
    leapMonth: components.leapMonth,
    repeatedDay: components.repeatedDay
  };
}
function attendeeRow(reminderId2, attendee, position) {
  return {
    id: JSON.stringify([reminderId2, "attendee", position]),
    reminderId: reminderId2,
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
function alarmRow(reminderId2, alarm, position) {
  return {
    id: JSON.stringify([reminderId2, position]),
    reminderId: reminderId2,
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
function relatedRows(reminder) {
  const reminderId2 = reminder.id;
  const attendees = reminder.attendees.map((attendee, position) => attendeeRow(reminderId2, attendee, position));
  const alarms = reminder.alarms.map((alarm, position) => alarmRow(reminderId2, alarm, position));
  const recurrenceRules = [];
  const recurrenceRuleValues = [];
  for (const [position, rule] of reminder.recurrenceRules.entries()) {
    const ruleId = JSON.stringify([reminderId2, "recurrenceRule", position]);
    recurrenceRules.push({
      id: ruleId,
      reminderId: reminderId2,
      position,
      calendarIdentifier: rule.calendarIdentifier ?? null,
      frequency: rule.frequency,
      interval: rule.interval,
      firstDayOfWeek: rule.firstDayOfWeek,
      endAt: timestamp(rule.end?.endMs),
      occurrenceCount: rule.end?.occurrenceCount ?? 0
    });
    const value = (component, index, value2, weekNumber) => ({
      id: JSON.stringify([ruleId, component, index]),
      reminderId: reminderId2,
      ruleId,
      component,
      position: index,
      value: value2,
      weekNumber
    });
    for (const [index, day] of rule.daysOfTheWeek.entries())
      recurrenceRuleValues.push(value("daysOfTheWeek", index, day.day, day.weekNumber));
    for (const component of [
      "daysOfTheMonth",
      "daysOfTheYear",
      "weeksOfTheYear",
      "monthsOfTheYear",
      "setPositions"
    ])
      for (const [index, number2] of rule[component].entries())
        recurrenceRuleValues.push(value(component, index, number2, null));
  }
  return { attendees, alarms, recurrenceRules, recurrenceRuleValues };
}

// packages/sources/apple/reminders/dist/reminder-fields.js
var { text, id, nullableText, integer, ordinal, boolean, number, nullableTimestamp, location: location2 } = eventKitFields;
var color = { type: ["number", "null"], minimum: 0, maximum: 1 };
var reminderId = {
  ...id,
  description: "Owning reminder; refers to reminders.id within this source."
};
var accountFields = {
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
var listFields = {
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
var attendeeFields = {
  id: {
    ...id,
    description: "JSON [reminderId, kind, position]; unique within this stream."
  },
  reminderId,
  position: {
    ...ordinal,
    description: "Order among the owner's participants of the same kind. Attendees are numbered in content order (URL, name, role, type), not EventKit's order, which changes between reads."
  },
  kind: {
    ...text,
    description: "Always 'attendee': an entry of EventKit EKCalendarItem.attendees. Reminders read no organizer."
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
    description: "JSON [reminderId, position]; unique within this stream."
  },
  reminderId,
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
    ...ordinal,
    description: "EventKit EKAlarm.proximity raw value (EKAlarmProximity): 0 none, 1 fires on entering, 2 on leaving the structured location. Unknown codes are kept as numbers."
  },
  ...locationFields("EKAlarm.structuredLocation")
};
var recurrenceRuleFields = {
  id: {
    ...id,
    description: 'JSON [reminderId, "recurrenceRule", position]; recurrenceRuleValues.ruleId refers to it.'
  },
  reminderId,
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
  reminderId,
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

// packages/sources/apple/reminders/dist/reminders-catalog.js
var { id: id2, text: text2, nullableText: nullableText2, nullableTimestamp: nullableTimestamp2, integer: integer2, boolean: boolean2 } = eventKitFields;
var streams = {
  accounts: {
    description: "One source record per EventKit account (EKSource) in this Mac's store, including accounts without reminder lists. An import scope keeps the selected accounts; a list scope also drops accounts owning no selected list. Relationships name source streams, not destination tables.",
    properties: accountFields
  },
  lists: {
    description: "One source record per reminder list (an EventKit calendar for reminders) visible on this Mac. An import scope keeps only the selected lists. accountId refers to accounts.id; reminders.listId refers to id. Relationships name source streams, not destination tables.",
    properties: listFields
  },
  reminders: {
    description: "One source record per reminder visible through EventKit on this Mac, completed reminders included, limited to the selected lists when an import scope is set. No date filter. Start and due dates live in dateComponents as native component sets; no UTC due timestamp is derived. dateComponents, attendees, alarms, recurrenceRules and recurrenceRuleValues refer to id through reminderId; listId refers to lists.id. Relationships name source streams, not destination tables.",
    properties: {
      id: {
        ...id2,
        description: "EventKit EKCalendarItem.calendarItemIdentifier; related streams refer to it through reminderId. Apple documents that a full sync can replace it."
      },
      listId: {
        ...id2,
        description: "EventKit EKCalendarItem.calendar.calendarIdentifier: the owning list; refers to lists.id within this source."
      },
      externalId: {
        ...nullableText2,
        description: "EventKit EKCalendarItem.calendarItemExternalIdentifier, the server-provided identifier; NULL when EventKit has none. Apple documents duplicates across calendars and, for Exchange reminders, different values between devices, so it is not unique."
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
      timeZone: {
        ...nullableText2,
        description: "EventKit EKCalendarItem.timeZone identifier; NULL when EventKit has none, which Apple documents as floating. The start and due component sets carry their own time zones in dateComponents."
      },
      createdAt: {
        ...nullableTimestamp2,
        description: "EventKit EKCalendarItem.creationDate as a UTC timestamp; NULL when EventKit has none."
      },
      modifiedAt: {
        ...nullableTimestamp2,
        description: "EventKit EKCalendarItem.lastModifiedDate as a UTC timestamp; NULL when EventKit has none."
      },
      completed: {
        ...boolean2,
        description: "EventKit EKReminder.isCompleted."
      },
      completedAt: {
        ...nullableTimestamp2,
        description: "EventKit EKReminder.completionDate as a UTC timestamp; NULL when EventKit has none."
      },
      priority: {
        ...integer2,
        minimum: 0,
        maximum: 9,
        description: "EventKit EKReminder.priority: 0 no priority, 1 highest through 9 lowest. Apple follows RFC 5545 (1 to 4 high, 5 medium, 6 to 9 low); its EKReminderPriority constants are 1 high, 5 medium and 9 low."
      }
    }
  },
  dateComponents: {
    description: "One source record per start or due date a reminder sets; a reminder without that date has no record. Each record keeps EventKit's NSDateComponents set whole: calendar, time zone, leap month and every component, with a missing component NULL and no manufactured UTC timestamp. A date without a time has NULL hour, minute and second. reminderId refers to reminders.id. Relationships name source streams, not destination tables.",
    properties: {
      id: {
        ...id2,
        description: "JSON [reminderId, kind]; unique within this stream."
      },
      reminderId: {
        ...id2,
        description: "Owning reminder; refers to reminders.id within this source."
      },
      kind: {
        ...text2,
        enum: ["start", "due"],
        description: "start for EventKit EKReminder.startDateComponents, due for EKReminder.dueDateComponents."
      },
      calendarIdentifier: {
        ...nullableText2,
        description: "Identifier of the NSDateComponents calendar, the calendar system the components count in; NULL when the set has no calendar."
      },
      timeZone: {
        ...nullableText2,
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
        ...boolean2,
        description: "NSDateComponents.isLeapMonth: whether month is a leap month in the set's calendar."
      },
      repeatedDay: {
        ...boolean2,
        description: "NSDateComponents.isRepeatedDay: whether day is a repeated day in the set's calendar."
      }
    }
  },
  attendees: {
    description: "One source record per attendee EventKit lists for a reminder. reminderId refers to reminders.id. Relationships name source streams, not destination tables.",
    properties: attendeeFields
  },
  alarms: {
    description: "One source record per EventKit alarm of a reminder, whether it fires at a time or at a location. reminderId refers to reminders.id. Relationships name source streams, not destination tables.",
    properties: alarmFields
  },
  recurrenceRules: {
    description: "One source record per EventKit recurrence rule of a reminder. reminderId refers to reminders.id; recurrenceRuleValues holds each rule's list values. Relationships name source streams, not destination tables.",
    properties: recurrenceRuleFields
  },
  recurrenceRuleValues: {
    description: "One source record per entry of a recurrence rule's day, week, month or set-position lists. ruleId refers to recurrenceRules.id and reminderId to reminders.id. Relationships name source streams, not destination tables.",
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
  // Every read is the whole store, so incremental copies diff snapshots.
  supportedSyncModes: ["full_refresh", "incremental"],
  sourceDefinedCursor: true,
  emitsDeletes: true
})));

// packages/sources/apple/reminders/dist/reminders-snapshot.js
var RemindersSnapshot = class {
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

// packages/sources/apple/reminders/dist/apple-reminders-source.js
var AppleRemindersSource = class extends Source {
  #store;
  identity = "apple-reminders:eventkit";
  catalog = catalog;
  accounts = catalog.get("accounts");
  lists = catalog.get("lists");
  reminders = catalog.get("reminders");
  dateComponents = catalog.get("dateComponents");
  attendees = catalog.get("attendees");
  alarms = catalog.get("alarms");
  recurrenceRules = catalog.get("recurrenceRules");
  recurrenceRuleValues = catalog.get("recurrenceRuleValues");
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
  async *observe({ streams: streams2, signal }) {
    for await (const _ of this.#store.watch(signal))
      yield streams2;
  }
  // Every selected stream from one change-free read, so reminders match
  // their lists and alarms their reminders.
  async open(streams2) {
    const rows = reminderRows(await this.#store.read({
      accountIds: this.scope.accountIds,
      calendarIds: this.scope.collectionIds
    }));
    return new RemindersSnapshot(new Map(streams2.map((stream) => [
      stream.name,
      validateRecords(stream, rows.get(stream.name), "EventKit")
    ])));
  }
  async *extract({ stream, syncMode }, state, _partition, snapshot) {
    const records = snapshot.of(stream.name);
    if (syncMode === "incremental")
      yield* diffSnapshot(stream, records, state);
    else
      for (const data of records)
        yield { stream: stream.name, data };
  }
};

// apps/apple/connectors/dist/apps/reminders/reminders-app.mjs
var RemindersApp = class extends AppleApp {
  name = "reminders";
  title = "Reminders";
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
  RemindersApp as default
};
