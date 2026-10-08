import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  ProactiveStore,
  appleDirectory,
  external_exports
} from "./chunks/chunk-4DVLIKSL.mjs";
import {
  __callDispose,
  __using
} from "./chunks/chunk-ZGXE7NZW.mjs";

// apps/apple/plugin/src/heartbeat-hook.ts
import { readFileSync } from "node:fs";

// apps/apple/plugin/src/gates/garden-gate.ts
import { existsSync as existsSync2 } from "node:fs";

// apps/apple/plugin/src/apple-imports.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
var AppleImports = class {
  #settings;
  constructor(directory) {
    this.#settings = join(directory, "settings.sqlite");
  }
  #selected() {
    var _stack = [];
    try {
      if (!existsSync(this.#settings)) return [];
      const settings = __using(_stack, new DatabaseSync(this.#settings, { readOnly: true }));
      return settings.prepare(
        "SELECT connector, database, connection_error, permissions FROM selected_connectors"
      ).all().map((row) => ({
        connector: String(row.connector),
        database: String(row.database),
        connectionError: row.connection_error === null ? null : String(row.connection_error),
        permissions: String(row.permissions)
      }));
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  // The connector's import file, or null while it is not selected or not yet
  // written.
  database(connector) {
    const selected = this.#selected().find(
      (item) => item.connector === connector
    );
    return selected !== void 0 && existsSync(selected.database) ? selected.database : null;
  }
  // Selected connectors whose import could not start, or whose latest pass
  // failed or loaded only in part.
  problems() {
    return this.#selected().flatMap(
      ({ connector, database, connectionError, permissions }) => {
        const problem = connectionError ?? passProblem(database);
        return problem === null ? [] : [{ connector, problem, permissions }];
      }
    );
  }
};
function passProblem(database) {
  var _stack = [];
  try {
    if (!existsSync(database)) return null;
    const reader = __using(_stack, new DatabaseSync(database, { readOnly: true }));
    const latest = reader.prepare("SELECT status, error FROM sync_status").get();
    if (latest?.status !== "failed" && latest?.status !== "partial") return null;
    return `${String(latest.status)}: ${String(latest.error)}`;
  } catch (_) {
    var _error = _, _hasError = true;
  } finally {
    __callDispose(_stack, _error, _hasError);
  }
}

// apps/apple/plugin/src/calendar-import.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
var dueMeetings = `SELECT e.eventId, e.name, e.startAt, e.endAt, c.name AS calendar, e.location, e.url, e.body, e.externalId,
    (SELECT json_group_array(json_object('name', a.name, 'email', substr(a.url, 8), 'kind', a.kind, 'status', a.status, 'role', a.role))
       FROM attendees a WHERE a.eventId = e.eventId AND a.isCurrentUser = 0 AND a.type IS NOT 2) AS attendees
  FROM events e JOIN calendars c ON c.id = e.calendarId
  WHERE e.allDay = 0 AND e.status IS NOT 3
    AND e.startAt >= @from AND e.startAt < @until
    AND ((c.subscribed = 0 AND c.type IN (0, 1, 2)) OR EXISTS (SELECT 1 FROM attendees a WHERE a.eventId = e.eventId))
    AND NOT EXISTS (SELECT 1 FROM attendees a WHERE a.eventId = e.eventId AND a.isCurrentUser = 1 AND a.status = 3)
    AND (EXISTS (SELECT 1 FROM attendees a WHERE a.eventId = e.eventId AND a.isCurrentUser = 0 AND a.type IS NOT 2)
      OR e.url IS NOT NULL OR e.location LIKE '%://%' OR e.body LIKE '%://%')
  ORDER BY e.startAt`;
var peopleMet = `SELECT lower(substr(a.url, 8)) AS email, max(a.name) AS name
  FROM attendees a JOIN events e ON e.eventId = a.eventId
  WHERE a.isCurrentUser = 0 AND a.type IS NOT 2 AND a.url LIKE 'mailto:%'
    AND e.status IS NOT 3 AND e.startAt >= @from AND e.startAt < @until
  GROUP BY lower(substr(a.url, 8)) ORDER BY min(e.startAt)`;
var text = (value) => value === null || value === void 0 ? null : String(value);
var CalendarImport = class {
  database;
  constructor(database) {
    this.database = database;
  }
  #all(sql, parameters) {
    var _stack = [];
    try {
      const reader = __using(_stack, new DatabaseSync2(this.database, { readOnly: true }));
      return reader.prepare(sql).all(parameters);
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  due(from, until) {
    return this.#all(dueMeetings, {
      from: from.toISOString(),
      until: until.toISOString()
    }).map((row) => ({
      eventId: String(row.eventId),
      name: String(row.name),
      startAt: String(row.startAt),
      endAt: String(row.endAt),
      calendar: String(row.calendar),
      location: text(row.location),
      url: text(row.url),
      body: text(row.body),
      externalId: text(row.externalId),
      attendees: JSON.parse(String(row.attendees))
    }));
  }
  // The current state of the given occurrences; one missing from the result
  // was deleted.
  occurrences(eventIds) {
    if (eventIds.length === 0) return [];
    return this.#all(
      `SELECT eventId, startAt, endAt, status FROM events WHERE eventId IN (SELECT value FROM json_each(@ids))`,
      { ids: JSON.stringify(eventIds) }
    ).map((row) => ({
      eventId: String(row.eventId),
      startAt: String(row.startAt),
      endAt: String(row.endAt),
      cancelled: row.status === 3
    }));
  }
  peopleMet(from, until) {
    return this.#all(peopleMet, {
      from: from.toISOString(),
      until: until.toISOString()
    }).map((row) => ({
      email: String(row.email),
      name: text(row.name) ?? String(row.email)
    }));
  }
};

// apps/apple/plugin/src/gates/heartbeat-gate.ts
var HeartbeatGate = class {
  answer(instructions2, directory, now) {
    if (!instructions2.includes(`$${this.skill}`)) return void 0;
    const work = this.due(directory, now);
    if ("quiet" in work) return { decision: "block", reason: work.quiet };
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: [
          `The Apple plugin hands you this work for $${this.skill}. Each section is one kind of work; act on every item as $${this.skill} describes.`,
          ...work.sections.map(
            ({ title, items }) => `${title}:
${JSON.stringify(items)}`
          )
        ].join("\n\n")
      }
    };
  }
};

// apps/apple/plugin/src/gates/garden-gate.ts
var minute = 6e4;
var day = 24 * 60 * minute;
var archiveAfter = 60 * minute;
var noteAge = 7 * day;
var noteRetry = day;
var notesPerRun = 5;
var recordRetention = 30 * day;
var before = (now, ms) => new Date(now.getTime() - ms).toISOString();
var GardenGate = class extends HeartbeatGate {
  skill = "garden-apple";
  due(directory, now) {
    var _stack = [];
    try {
      if (!existsSync2(directory)) return { quiet: "Apple is not set up." };
      const imports = new AppleImports(directory);
      const database = imports.database("calendar");
      const calendar = database === null ? null : new CalendarImport(database);
      const store = __using(_stack, new ProactiveStore(directory));
      const sections = [
        chatsToArchive(store, calendar, now),
        problemsToReport(store, imports),
        calendar === null ? null : peopleToNote(store, calendar, now)
      ].filter((section) => section !== null);
      store.prune(before(now, recordRetention));
      return sections.length > 0 ? { sections } : { quiet: "Nothing to tend." };
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
};
function chatsToArchive(store, calendar, now) {
  const open = store.openChats();
  const current = new Map(
    (calendar?.occurrences(open.map(({ eventId }) => eventId)) ?? []).map(
      (occurrence) => [occurrence.eventId, occurrence]
    )
  );
  const over = open.filter(({ eventId, endAt, cancelled }) => {
    if (cancelled) return true;
    if (calendar === null) return endAt <= before(now, archiveAfter);
    const occurrence = current.get(eventId);
    return occurrence === void 0 || occurrence.cancelled || occurrence.endAt <= before(now, archiveAfter);
  });
  if (over.length === 0) return null;
  store.archiveHanded(
    over.map(({ eventId }) => eventId),
    now.toISOString()
  );
  return {
    title: "Meeting chats to archive",
    items: over.map(({ threadId, name, startAt }) => ({
      threadId,
      name,
      startAt
    }))
  };
}
function problemsToReport(store, imports) {
  const problems = imports.problems().map((problem) => ({
    ...problem,
    key: `${problem.connector}
${problem.problem}`
  }));
  const reported = store.reported();
  const unreported = problems.filter(({ key }) => !reported.has(key));
  store.keepReports(problems.map(({ key }) => key));
  if (unreported.length === 0) return null;
  return {
    title: "Import problems to report",
    items: unreported.map(({ connector, problem, permissions }) => ({
      connector,
      problem,
      permissions
    }))
  };
}
function peopleToNote(store, calendar, now) {
  const people = store.notesDue(
    calendar.peopleMet(
      new Date(now.getTime() - 30 * day),
      new Date(now.getTime() + 7 * day)
    ),
    {
      staleBefore: before(now, noteAge),
      requestedBefore: before(now, noteRetry)
    }
  ).slice(0, notesPerRun);
  if (people.length === 0) return null;
  store.requestNotes(people, now.toISOString());
  return { title: "People to write notes about", items: people };
}

// apps/apple/plugin/src/gates/meeting-prep-gate.ts
var leadMinutes = 40;
var MeetingPrepGate = class extends HeartbeatGate {
  skill = "meeting-prep";
  due(directory, now) {
    var _stack = [];
    try {
      const database = new AppleImports(directory).database("calendar");
      if (database === null) return { quiet: "Calendar is not imported." };
      const calendar = new CalendarImport(database);
      const store = __using(_stack, new ProactiveStore(directory));
      const handed = store.meetings();
      const known = new Set(handed.map(({ eventId }) => eventId));
      const fresh = calendar.due(now, new Date(now.getTime() + leadMinutes * 6e4)).filter(({ eventId }) => !known.has(eventId));
      const briefed = handed.filter(
        ({ threadId, cancelled: cancelled2 }) => threadId !== null && !cancelled2
      );
      const current = new Map(
        calendar.occurrences(briefed.map(({ eventId }) => eventId)).map((occurrence) => [occurrence.eventId, occurrence])
      );
      const moved = [];
      const cancelled = [];
      for (const meeting of briefed) {
        const occurrence = current.get(meeting.eventId);
        if (occurrence === void 0 || occurrence.cancelled)
          cancelled.push(meeting);
        else if (occurrence.startAt !== meeting.startAt && occurrence.startAt >= now.toISOString())
          moved.push({ ...meeting, ...occurrence });
      }
      store.hand(fresh);
      for (const meeting of moved) store.move(meeting);
      for (const { eventId } of cancelled) store.cancel(eventId);
      const sections = [];
      if (fresh.length > 0)
        sections.push({
          title: `New meetings, found in the Calendar import "${database}"`,
          items: fresh.map((meeting) => ({
            ...meeting,
            attendees: meeting.attendees.map((attendee) => ({
              ...attendee,
              note: store.note(attendee.email.toLowerCase())
            }))
          }))
        });
      if (moved.length > 0)
        sections.push({
          title: "Moved meetings",
          items: moved.map(({ threadId, name, startAt, endAt }) => ({
            threadId,
            name,
            startAt,
            endAt
          }))
        });
      if (cancelled.length > 0)
        sections.push({
          title: "Cancelled meetings",
          items: cancelled.map(({ threadId, name, startAt }) => ({
            threadId,
            name,
            startAt
          }))
        });
      return sections.length > 0 ? { sections } : { quiet: "No meeting to prepare yet." };
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
};

// apps/apple/plugin/src/heartbeat-hook.ts
var { prompt } = external_exports.object({ prompt: external_exports.string() }).parse(JSON.parse(readFileSync(0, "utf8")));
var instructions = /^<heartbeat>[\s\S]*?<instructions>([\s\S]*?)<\/instructions>/.exec(
  prompt
)?.[1];
if (instructions !== void 0) {
  const now = /* @__PURE__ */ new Date();
  for (const gate of [new MeetingPrepGate(), new GardenGate()]) {
    const output = gate.answer(instructions, appleDirectory(), now);
    if (output !== void 0) {
      process.stdout.write(JSON.stringify(output));
      break;
    }
  }
}
