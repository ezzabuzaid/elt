import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  eventKitFields
} from "./chunk-YUEL2AIL.mjs";
import {
  Catalog,
  Stream
} from "./chunk-OEQ4WCEQ.mjs";
import {
  __callDispose,
  __using
} from "./chunk-ZGXE7NZW.mjs";

// packages/sources/apple/eventkit/dist/eventkit.js
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// packages/sources/apple/eventkit/dist/native-process.js
import { spawn } from "node:child_process";
import { addAbortListener } from "node:events";
import { createInterface } from "node:readline";
var NativeProcess = class {
  // Each stdout line of the process as it arrives. A non-zero exit rejects with
  // the process's stderr, unless the signal stopped it.
  async *lines(file, args, signal = new AbortController().signal) {
    var _stack = [];
    try {
      if (signal.aborted)
        return;
      const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
      let failure;
      child.on("error", (error) => {
        failure = error;
      });
      const closed = new Promise((resolve) => child.once("close", () => resolve()));
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      const _cancellation = __using(_stack, addAbortListener(signal, () => {
        child.kill();
      }));
      const lines = __using(_stack, createInterface({ input: child.stdout }));
      try {
        for await (const line of lines)
          yield line;
        await closed;
        if (failure)
          throw failure;
        if (!signal.aborted && child.exitCode !== 0)
          throw Object.assign(new Error(`${file} exited: ${stderr.trim()}`), {
            stderr,
            code: child.exitCode,
            signal: child.signalCode
          });
      } finally {
        child.kill();
        await closed;
      }
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
};
var native_process_default = new NativeProcess();

// packages/sources/apple/eventkit/dist/eventkit.js
var CalendarUnavailableError = class extends Error {
  name = "CalendarUnavailableError";
  constructor(cause) {
    super("Calendar requires full Calendar access for the process running the export. Allow access in System Settings > Privacy & Security > Calendars. A sandbox can prevent access even when permission is granted.", { cause });
  }
};
var RemindersUnavailableError = class extends Error {
  name = "RemindersUnavailableError";
  constructor(cause) {
    super("Reminders requires full Reminders access for the process running the export. Allow access in System Settings > Privacy & Security > Reminders. A sandbox can prevent access even when permission is granted.", { cause });
  }
};
var EventKitChangingError = class extends Error {
  name = "EventKitChangingError";
  constructor(entity, attempts) {
    super(`EventKit ${entity} changed during each of ${attempts} consistent reads; run the export again when edits settle.`);
  }
};
var EventKitSnapshot = class {
  records;
  constructor(records) {
    this.records = records;
  }
  of(stream) {
    const records = this.records.get(stream);
    if (records === void 0)
      throw new TypeError(`Stream ${stream} was not read in this session`);
    return records;
  }
  async [Symbol.asyncDispose]() {
  }
};
var helper = fileURLToPath(new URL("./eventkit", import.meta.url));
var EventKit = class {
  entity;
  constructor(entity) {
    this.entity = entity;
  }
  // One read of the whole store, in one helper process.
  async read(request) {
    const documents = [];
    try {
      for await (const line of native_process_default.lines(helper, [
        "read",
        JSON.stringify({ entity: this.entity, ...request })
      ]))
        documents.push(JSON.parse(line));
    } catch (error) {
      throw this.unavailable(error);
    }
    return documents;
  }
  // EventKit has no read transaction. Reads run while a watcher counts
  // EKEventStoreChangedNotification and repeat when a change arrived during
  // them or within settleMs after, the notification's delivery delay.
  async consistently(read, { settleMs = 250, attempts = 5 } = {}) {
    const controller = new AbortController();
    const changes = this.watch(controller.signal)[Symbol.asyncIterator]();
    let count = 0;
    let failure;
    await changes.next();
    const counting = (async () => {
      try {
        while (!(await changes.next()).done)
          count++;
      } catch (error) {
        if (!controller.signal.aborted)
          failure = { error };
      }
    })();
    try {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const before = count;
        const value = await read();
        await sleep(settleMs);
        if (failure !== void 0)
          throw failure.error;
        if (count === before)
          return value;
      }
      throw new EventKitChangingError(this.entity, attempts);
    } finally {
      controller.abort();
      await counting;
    }
  }
  async *watch(signal) {
    try {
      for await (const message of native_process_default.lines(helper, ["watch", this.entity], signal)) {
        if (message !== "changed")
          throw new TypeError("EventKit watcher returned an invalid notification");
        yield;
      }
      if (!signal.aborted)
        throw new Error("EventKit watcher stopped unexpectedly");
    } catch (error) {
      throw this.unavailable(error);
    }
  }
  get marker() {
    return this.entity === "events" ? "CALENDAR_UNAVAILABLE" : "REMINDERS_UNAVAILABLE";
  }
  unavailable(error) {
    if (error instanceof Error && "stderr" in error && typeof error.stderr === "string" && error.stderr.includes(this.marker)) {
      const Unavailable = this.entity === "events" ? CalendarUnavailableError : RemindersUnavailableError;
      return new Unavailable(error);
    }
    return error;
  }
};

// packages/sources/apple/eventkit/dist/eventkit-schema.js
var { text, id, nullableText, integer, ordinal, boolean, number, nullableTimestamp, location } = eventKitFields;
var color = { type: ["number", "null"], minimum: 0, maximum: 1 };
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

// packages/sources/apple/eventkit/dist/eventkit-rows.js
function timestamp(ms) {
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
function scopedCollections(scope, accounts, calendars) {
  if (scope.accountIds === void 0 && scope.collectionIds === void 0)
    return { accounts, calendars };
  const selected = calendars.filter((calendar) => calendar.selected);
  return {
    accounts: accounts.filter((account) => (scope.accountIds?.includes(account.id) ?? true) && (scope.collectionIds === void 0 || selected.some((calendar) => calendar.accountId === account.id))),
    calendars: selected
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
    allowedEntityTypes: calendar.allowedEntityTypes
  };
}
function inContentOrder(values, key) {
  return values.map((value) => [JSON.stringify(key(value)), value]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
}
function participantRow(itemId, ownerKey, participant, kind, position) {
  return {
    id: JSON.stringify([itemId, kind, position]),
    [ownerKey]: itemId,
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
function alarmValues(alarm) {
  return {
    type: alarm.alarmType,
    relativeOffset: alarm.relativeOffset,
    absoluteAt: timestamp(alarm.absoluteMs),
    emailAddress: alarm.emailAddress ?? null,
    soundName: alarm.soundName ?? null,
    proximity: alarm.proximity,
    ...location2(alarm.location)
  };
}
function relatedRows(item, itemId, ownerKey) {
  const attendees = [];
  if (item.organizer !== void 0)
    attendees.push(participantRow(itemId, ownerKey, item.organizer, "organizer", 0));
  const ordered = inContentOrder(item.attendees, (attendee) => [
    attendee.url,
    attendee.name ?? null,
    attendee.role,
    attendee.participantType
  ]);
  for (const [position, attendee] of ordered.entries())
    attendees.push(participantRow(itemId, ownerKey, attendee, "attendee", position));
  const alarms = inContentOrder(item.alarms.map(alarmValues), (alarm) => Object.values(alarm)).map((alarm, position) => ({
    id: JSON.stringify([itemId, position]),
    [ownerKey]: itemId,
    position,
    ...alarm
  }));
  const recurrenceRules = [];
  const recurrenceRuleValues = [];
  for (const [position, rule] of item.recurrenceRules.entries()) {
    const ruleId = JSON.stringify([itemId, "recurrenceRule", position]);
    recurrenceRules.push({
      id: ruleId,
      [ownerKey]: itemId,
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
      [ownerKey]: itemId,
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

export {
  EventKitSnapshot,
  EventKit,
  eventKitAccountFields,
  eventKitCalendarFields,
  eventKitLocationFields,
  eventKitRelatedFields,
  eventKitCatalog,
  timestamp,
  location2 as location,
  scopedCollections,
  accountRow,
  calendarRow,
  relatedRows
};
