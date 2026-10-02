import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  EventKit,
  EventKitSnapshot,
  accountRow,
  calendarRow,
  relatedRows,
  scopedCollections,
  timestamp
} from "../../chunks/chunk-BNDLXB7J.mjs";
import {
  accounts,
  collections,
  name
} from "../../chunks/chunk-MHNP6BIT.mjs";
import {
  eventKitAccountFields,
  eventKitCalendarFields,
  eventKitCatalog,
  eventKitFields,
  eventKitRelatedFields
} from "../../chunks/chunk-QPQDBO5R.mjs";
import {
  localAppleStoreCoverage
} from "../../chunks/chunk-4HBD6YP5.mjs";
import {
  AppleApp,
  Source,
  diffSnapshot,
  validateRecords
} from "../../chunks/chunk-PU5AI37R.mjs";
import "../../chunks/chunk-ZGXE7NZW.mjs";

// apps/apple/connectors/dist/sources/apple-reminders/reminder-rows.js
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
function reminderRows(documents, scope) {
  const accounts2 = [];
  const lists = [];
  const reminders = [];
  for (const document of documents) {
    if (document.type === "account")
      accounts2.push(document);
    else if (document.type === "calendar")
      lists.push(document);
    else if (document.type === "reminder")
      reminders.push(document);
  }
  const collections2 = scopedCollections(scope, accounts2, lists);
  const related2 = reminders.map((reminder) => relatedRows(reminder, reminder.id, "reminderId"));
  return /* @__PURE__ */ new Map([
    ["accounts", collections2.accounts.map(accountRow)],
    ["lists", collections2.calendars.map(calendarRow)],
    ["reminders", reminders.map(reminderRow)],
    [
      "dateComponents",
      reminders.flatMap((reminder) => ["start", "due"].flatMap((kind) => {
        const components = reminder[kind];
        return components === void 0 ? [] : [dateComponentsRow(reminder.id, kind, components)];
      }))
    ],
    ["attendees", related2.flatMap((rows) => rows.attendees)],
    ["alarms", related2.flatMap((rows) => rows.alarms)],
    ["recurrenceRules", related2.flatMap((rows) => rows.recurrenceRules)],
    [
      "recurrenceRuleValues",
      related2.flatMap((rows) => rows.recurrenceRuleValues)
    ]
  ]);
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
function dateComponentsRow(reminderId, kind, components) {
  return {
    id: JSON.stringify([reminderId, kind]),
    reminderId,
    kind,
    calendarIdentifier: components.calendarIdentifier ?? null,
    timeZone: components.timeZone ?? null,
    ...Object.fromEntries(dateComponentNames.map((name2) => [name2, components[name2] ?? null])),
    leapMonth: components.leapMonth,
    repeatedDay: components.repeatedDay
  };
}

// apps/apple/connectors/dist/sources/apple-reminders/apple-reminders-source.js
var { id, text, nullableText, nullableTimestamp, integer, boolean } = eventKitFields;
var related = eventKitRelatedFields("reminderId");
var catalog = eventKitCatalog({
  accounts: {
    description: "One source record per EventKit account (EKSource) in this Mac's store, including accounts without reminder lists. An import scope keeps the selected accounts; a list scope also drops accounts owning no selected list. Relationships name source streams, not destination tables.",
    properties: eventKitAccountFields
  },
  lists: {
    description: "One source record per reminder list (an EventKit calendar for reminders) visible on this Mac. An import scope keeps only the selected lists. accountId refers to accounts.id; reminders.listId refers to id. Relationships name source streams, not destination tables.",
    properties: eventKitCalendarFields
  },
  reminders: {
    description: "One source record per reminder visible through EventKit on this Mac, completed reminders included, limited to the selected lists when an import scope is set. No date filter. Start and due dates live in dateComponents as native component sets; no UTC due timestamp is derived. dateComponents, attendees, alarms, recurrenceRules and recurrenceRuleValues refer to id through reminderId; listId refers to lists.id. Relationships name source streams, not destination tables.",
    properties: {
      id: {
        ...id,
        description: "EventKit EKCalendarItem.calendarItemIdentifier; related streams refer to it through reminderId. Apple documents that a full sync can replace it."
      },
      listId: {
        ...id,
        description: "EventKit EKCalendarItem.calendar.calendarIdentifier: the owning list; refers to lists.id within this source."
      },
      externalId: {
        ...nullableText,
        description: "EventKit EKCalendarItem.calendarItemExternalIdentifier, the server-provided identifier; NULL when EventKit has none. Apple documents duplicates across calendars and, for Exchange reminders, different values between devices, so it is not unique."
      },
      name: { ...text, description: "EventKit EKCalendarItem.title." },
      body: {
        ...nullableText,
        description: "EventKit EKCalendarItem.notes; NULL when unset."
      },
      location: {
        ...nullableText,
        description: "EventKit EKCalendarItem.location; NULL when unset."
      },
      url: {
        ...nullableText,
        description: "EventKit EKCalendarItem.URL as a string; NULL when unset."
      },
      timeZone: {
        ...nullableText,
        description: "EventKit EKCalendarItem.timeZone identifier; NULL when EventKit has none, which Apple documents as floating. The start and due component sets carry their own time zones in dateComponents."
      },
      createdAt: {
        ...nullableTimestamp,
        description: "EventKit EKCalendarItem.creationDate as a UTC timestamp; NULL when EventKit has none."
      },
      modifiedAt: {
        ...nullableTimestamp,
        description: "EventKit EKCalendarItem.lastModifiedDate as a UTC timestamp; NULL when EventKit has none."
      },
      completed: {
        ...boolean,
        description: "EventKit EKReminder.isCompleted."
      },
      completedAt: {
        ...nullableTimestamp,
        description: "EventKit EKReminder.completionDate as a UTC timestamp; NULL when EventKit has none."
      },
      priority: {
        ...integer,
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
        ...id,
        description: "JSON [reminderId, kind]; unique within this stream."
      },
      reminderId: {
        ...id,
        description: "Owning reminder; refers to reminders.id within this source."
      },
      kind: {
        ...text,
        enum: ["start", "due"],
        description: "start for EventKit EKReminder.startDateComponents, due for EKReminder.dueDateComponents."
      },
      calendarIdentifier: {
        ...nullableText,
        description: "Identifier of the NSDateComponents calendar, the calendar system the components count in; NULL when the set has no calendar."
      },
      timeZone: {
        ...nullableText,
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
        ...boolean,
        description: "NSDateComponents.isLeapMonth: whether month is a leap month in the set's calendar."
      },
      repeatedDay: {
        ...boolean,
        description: "NSDateComponents.isRepeatedDay: whether day is a repeated day in the set's calendar."
      }
    }
  },
  attendees: {
    description: "One source record per attendee EventKit lists for a reminder. reminderId refers to reminders.id. Relationships name source streams, not destination tables.",
    properties: related.attendees
  },
  alarms: {
    description: "One source record per EventKit alarm of a reminder, whether it fires at a time or at a location. reminderId refers to reminders.id. Relationships name source streams, not destination tables.",
    properties: related.alarms
  },
  recurrenceRules: {
    description: "One source record per EventKit recurrence rule of a reminder. reminderId refers to reminders.id; recurrenceRuleValues holds each rule's list values. Relationships name source streams, not destination tables.",
    properties: related.recurrenceRules
  },
  recurrenceRuleValues: {
    description: "One source record per entry of a recurrence rule's day, week, month or set-position lists. ruleId refers to recurrenceRules.id and reminderId to reminders.id. Relationships name source streams, not destination tables.",
    properties: related.recurrenceRuleValues
  }
}, { snapshot: true });
var AppleRemindersSource = class extends Source {
  #eventKit = new EventKit("reminders");
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
  constructor(scope = {}) {
    super();
    this.scope = scope;
    Object.freeze(this);
  }
  coverage(_stream) {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }
  async *observe({ streams, signal }) {
    for await (const _ of this.#eventKit.watch(signal))
      yield streams;
  }
  // Every selected stream from one change-free read, so reminders match
  // their lists and alarms their reminders.
  async open(streams) {
    const { accountIds, collectionIds } = this.scope;
    return new EventKitSnapshot(await this.#eventKit.consistently(async () => {
      const rows = reminderRows(await this.#eventKit.read({ accountIds, collectionIds }), this.scope);
      return new Map(streams.map((stream) => [
        stream.name,
        validateRecords(stream, rows.get(stream.name), "EventKit")
      ]));
    }));
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
    return new AppleRemindersSource(scope);
  }
};
export {
  RemindersApp as default
};
