import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  __callDispose,
  __using
} from "./chunk-ZGXE7NZW.mjs";

// packages/sdks/apple/eventkit/dist/errors.js
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

// packages/sdks/apple/eventkit/dist/eventkit-store.js
import { setInterval, setTimeout as sleep } from "node:timers/promises";

// packages/sdks/apple/eventkit/dist/native-process.js
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

// packages/sdks/apple/eventkit/dist/eventkit-store.js
var settleMs = 250;
var checkMs = 1e3;
var attempts = 5;
var EventKitStore = class {
  // The compiled helper (helper/*.swift). Its host decides where it lives:
  // beside this package's dist, or beside a bundled server.
  #helper;
  constructor(helper) {
    this.#helper = helper;
  }
  async read(query) {
    return this.#consistent(async () => {
      const documents = await this.#documents(query, this.request(query));
      return this.contents(scoped(query, documents), documents);
    });
  }
  // The accounts and calendars read(query) returns, without their items or a
  // window: a short read, which a store too busy for the whole read holds
  // still for.
  async collections(query) {
    return this.#consistent(async () => scoped(query, await this.#documents(query, { collectionsOnly: true })));
  }
  // Yields changed once the subscription is confirmed and once per store
  // change, and unchanged each checkMs in between: a quiet second under a
  // live subscription is a check that found the store unchanged. A consumer
  // that stops reading stops the helper, as an abort does: a change the watch
  // still waits for would otherwise hold its return forever.
  async *checks(signal) {
    const controller = new AbortController();
    const checking = AbortSignal.any([signal, controller.signal]);
    const changes = this.watch(checking)[Symbol.asyncIterator]();
    try {
      if ((await changes.next()).done)
        return;
      yield "changed";
      const ticks = setInterval(checkMs, void 0, { signal: checking })[Symbol.asyncIterator]();
      const nextChange = () => changes.next().then(({ done }) => ({ done, changed: true }));
      const nextTick = () => ticks.next().then(({ done }) => ({ done, changed: false }));
      let change = nextChange();
      let tick = nextTick();
      for (; ; ) {
        const next = await Promise.race([change, tick]);
        if (next.done)
          return;
        yield next.changed ? "changed" : "unchanged";
        if (next.changed)
          change = nextChange();
        else
          tick = nextTick();
      }
    } catch (error) {
      if (!(signal.aborted && error instanceof Error && error.name === "AbortError"))
        throw error;
    } finally {
      controller.abort();
      await changes.return(void 0);
    }
  }
  // Yields once the subscription is confirmed, then once per store change.
  async *watch(signal) {
    try {
      for await (const message of native_process_default.lines(this.#helper, ["watch", this.entity], signal)) {
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
  // EventKit has no read transaction. Reads run while a watcher counts
  // EKEventStoreChangedNotification and repeat when a change arrived during
  // them or within settleMs after.
  async #consistent(readOnce) {
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
        const result = await readOnce();
        await sleep(settleMs);
        if (failure !== void 0)
          throw failure.error;
        if (count === before)
          return result;
      }
      throw new EventKitChangingError(this.entity, attempts);
    } finally {
      controller.abort();
      await counting;
    }
  }
  async #documents(query, request) {
    const documents = [];
    try {
      for await (const line of native_process_default.lines(this.#helper, [
        "read",
        JSON.stringify({
          entity: this.entity,
          ...request,
          accountIds: query.accountIds,
          collectionIds: query.calendarIds
        })
      ]))
        documents.push(inContentOrder(JSON.parse(line)));
    } catch (error) {
      throw this.failure(error);
    }
    return documents;
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
      alarm.absoluteMs ?? null,
      alarm.relativeOffset,
      alarm.alarmType,
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
  return values.toSorted((a, b) => compareKeys(key(a), key(b)));
}
function compareKeys(a, b) {
  for (const [index, left] of a.entries()) {
    const right = b[index];
    if (left === right)
      continue;
    if (left === null)
      return -1;
    if (right === null)
      return 1;
    if (typeof left === "number" && typeof right === "number")
      return left - right;
    return String(left) < String(right) ? -1 : 1;
  }
  return 0;
}

// packages/sdks/apple/eventkit/dist/calendar-store.js
var CalendarStore = class extends EventKitStore {
  entity = "events";
  accessMarker = "CALENDAR_UNAVAILABLE";
  request({ startAt, endAt, ics }) {
    return { startAt, endAt, ics };
  }
  // EventKit can expand one all-day occurrence twice in its day, at two UTC
  // offsets: a yearly holiday read in Asia/Amman came back on 2016-06-14 from
  // midnight at +03:00 and again at +02:00. An all-day occurrence fills its
  // day, so an item has at most one starting on a day; the first is kept.
  contents(collections, documents) {
    const days = /* @__PURE__ */ new Set();
    return {
      ...collections,
      occurrences: documents.filter((document) => document.type === "occurrence").filter(({ allDay, calendarId, calendarItemId, startDay }) => {
        if (!allDay)
          return true;
        const day = JSON.stringify([calendarId, calendarItemId, startDay]);
        if (days.has(day))
          return false;
        days.add(day);
        return true;
      }),
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

// packages/sdks/apple/eventkit/dist/reminders-store.js
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
  CalendarUnavailableError,
  RemindersUnavailableError,
  IcsExportUnavailableError,
  CalendarStore,
  RemindersStore
};
