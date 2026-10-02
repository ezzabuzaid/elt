import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  __callDispose,
  __using
} from "./chunk-ZGXE7NZW.mjs";

// apps/apple/connectors/dist/platform/macos/eventkit.js
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// apps/apple/connectors/dist/platform/macos/native-process.js
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

// apps/apple/connectors/dist/platform/macos/eventkit.js
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

// apps/apple/connectors/dist/sources/eventkit-rows.js
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
    ...location(alarm.location)
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
      for (const [index, number] of rule[component].entries())
        recurrenceRuleValues.push(value(component, index, number, null));
  }
  return { attendees, alarms, recurrenceRules, recurrenceRuleValues };
}

export {
  EventKitSnapshot,
  EventKit,
  timestamp,
  location,
  scopedCollections,
  accountRow,
  calendarRow,
  relatedRows
};
