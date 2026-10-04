import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  __callDispose,
  __using
} from "./chunk-ZGXE7NZW.mjs";

// packages/macos/eventkit/dist/errors.js
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
var IcsExportUnavailableError = class extends Error {
  name = "IcsExportUnavailableError";
  constructor(cause) {
    super("This macOS version does not provide the private EventKit ICS export.", { cause });
  }
};
var EventKitChangingError = class extends Error {
  name = "EventKitChangingError";
  constructor(entity, attempts2) {
    super(`EventKit ${entity} changed during each of ${attempts2} consistent reads; run the export again when edits settle.`);
  }
};

// packages/macos/eventkit/dist/eventkit-store.js
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// packages/macos/eventkit/dist/native-process.js
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

// packages/macos/eventkit/dist/eventkit-store.js
var helper = fileURLToPath(new URL("./eventkit-helper", import.meta.url));
var settleMs = 250;
var attempts = 5;
var EventKitStore = class {
  // EventKit has no read transaction. Reads run while a watcher counts
  // EKEventStoreChangedNotification and repeat when a change arrived during
  // them or within settleMs after.
  async read(query) {
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
        const contents = await this.#readOnce(query);
        await sleep(settleMs);
        if (failure !== void 0)
          throw failure.error;
        if (count === before)
          return contents;
      }
      throw new EventKitChangingError(this.entity, attempts);
    } finally {
      controller.abort();
      await counting;
    }
  }
  // Yields once the subscription is confirmed, then once per store change.
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
      throw this.failure(error);
    }
  }
  failure(error) {
    return helperStderr(error).includes(this.accessMarker) ? this.accessDenied(error) : error;
  }
  async #readOnce(query) {
    const request = {
      entity: this.entity,
      ...this.request(query),
      accountIds: query.accountIds,
      collectionIds: query.calendarIds
    };
    const documents = [];
    try {
      for await (const line of native_process_default.lines(helper, [
        "read",
        JSON.stringify(request)
      ]))
        documents.push(inContentOrder(JSON.parse(line)));
    } catch (error) {
      throw this.failure(error);
    }
    return this.contents(scoped(query, documents), documents);
  }
};
function helperStderr(error) {
  return error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
}
function scoped(query, documents) {
  const accounts = documents.filter((document) => document.type === "account");
  const calendars = documents.filter((document) => document.type === "calendar");
  if (query.accountIds === void 0 && query.calendarIds === void 0)
    return { accounts, calendars: calendars.map(withoutSelection) };
  const selected = calendars.filter((calendar) => calendar.selected).map(withoutSelection);
  return {
    accounts: accounts.filter((account) => (query.accountIds?.includes(account.id) ?? true) && (query.calendarIds === void 0 || selected.some((calendar) => calendar.accountId === account.id))),
    calendars: selected
  };
}
function withoutSelection({ selected, ...calendar }) {
  return calendar;
}
function inContentOrder(document) {
  if (!("attendees" in document))
    return document;
  return {
    ...document,
    attendees: sorted(document.attendees, (attendee) => [
      attendee.url,
      attendee.name ?? null,
      attendee.role,
      attendee.participantType
    ]),
    alarms: sorted(document.alarms, (alarm) => [
      alarm.alarmType,
      alarm.relativeOffset,
      alarm.absoluteMs ?? null,
      alarm.emailAddress ?? null,
      alarm.soundName ?? null,
      alarm.proximity,
      alarm.location?.title ?? null,
      alarm.location?.latitude ?? null,
      alarm.location?.longitude ?? null,
      alarm.location?.radius ?? null
    ])
  };
}
function sorted(values, key) {
  return values.map((value) => [JSON.stringify(key(value)), value]).sort(([a], [b]) => {
    if (a < b)
      return -1;
    return a > b ? 1 : 0;
  }).map(([, value]) => value);
}

// packages/macos/eventkit/dist/calendar-store.js
var CalendarStore = class extends EventKitStore {
  entity = "events";
  accessMarker = "CALENDAR_UNAVAILABLE";
  request({ startAt, endAt, ics }) {
    return { startAt, endAt, ics };
  }
  contents(collections, documents) {
    return {
      ...collections,
      occurrences: documents.filter((document) => document.type === "occurrence"),
      icsExports: documents.filter((document) => document.type === "ics")
    };
  }
  accessDenied(cause) {
    return new CalendarUnavailableError(cause);
  }
  failure(error) {
    return helperStderr(error).includes("CALENDAR_ICS_UNAVAILABLE") ? new IcsExportUnavailableError(error) : super.failure(error);
  }
};

// packages/macos/eventkit/dist/reminders-store.js
var RemindersStore = class extends EventKitStore {
  entity = "reminders";
  accessMarker = "REMINDERS_UNAVAILABLE";
  request() {
    return {};
  }
  contents(collections, documents) {
    return {
      ...collections,
      reminders: documents.filter((document) => document.type === "reminder")
    };
  }
  accessDenied(cause) {
    return new RemindersUnavailableError(cause);
  }
};

export {
  IcsExportUnavailableError,
  CalendarStore,
  RemindersStore
};
