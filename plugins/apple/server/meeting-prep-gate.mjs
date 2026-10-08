import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  appleDirectory,
  external_exports
} from "./chunks/chunk-KFOK7EIP.mjs";
import {
  __callDispose,
  __using
} from "./chunks/chunk-ZGXE7NZW.mjs";

// apps/apple/plugin/src/meeting-prep-gate.ts
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
var leadMinutes = 40;
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
var handedSchema = external_exports.array(
  external_exports.strictObject({ eventId: external_exports.string(), startAt: external_exports.string() })
);
function gate(prompt2, now) {
  const instructions = /^<heartbeat>[\s\S]*?<instructions>([\s\S]*?)<\/instructions>/.exec(
    prompt2
  )?.[1];
  if (!instructions?.includes("$meeting-prep")) return void 0;
  const directory = appleDirectory();
  const settingsFile = join(directory, "settings.sqlite");
  if (!existsSync(settingsFile)) return block("Apple is not set up.");
  const calendar = (() => {
    var _stack = [];
    try {
      const settings = __using(_stack, new DatabaseSync(settingsFile, { readOnly: true }));
      return settings.prepare(
        "SELECT database FROM selected_connectors WHERE connector = 'calendar'"
      ).get()?.database;
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  })();
  if (typeof calendar !== "string" || !existsSync(calendar))
    return block("Calendar is not imported.");
  const meetings = (() => {
    var _stack = [];
    try {
      const database = __using(_stack, new DatabaseSync(calendar, { readOnly: true }));
      return database.prepare(dueMeetings).all({
        from: now.toISOString(),
        until: new Date(now.getTime() + leadMinutes * 6e4).toISOString()
      });
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  })();
  const ledger = join(directory, "meeting-prep.json");
  const handed = existsSync(ledger) ? handedSchema.parse(JSON.parse(readFileSync(ledger, "utf8"))) : [];
  const due = meetings.filter(
    ({ eventId, startAt }) => !handed.some(
      (meeting) => meeting.eventId === eventId && meeting.startAt === startAt
    )
  );
  if (due.length === 0) return block("No meeting to prepare yet.");
  const kept = [
    ...handed.filter(({ startAt }) => startAt >= now.toISOString()),
    ...due.map(({ eventId, startAt }) => ({
      eventId: String(eventId),
      startAt: String(startAt)
    }))
  ];
  writeFileSync(`${ledger}.tmp`, JSON.stringify(kept));
  renameSync(`${ledger}.tmp`, ledger);
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: [
        `The Apple plugin hands you these meetings to prepare now, found in the Calendar import "${calendar}". Brief each with $meeting-prep from its step 2: each row below is that meeting's step 1 result.`,
        JSON.stringify(due)
      ].join("\n")
    }
  };
}
function block(reason) {
  return { decision: "block", reason };
}
var { prompt } = external_exports.object({ prompt: external_exports.string() }).parse(JSON.parse(readFileSync(0, "utf8")));
var output = gate(prompt, /* @__PURE__ */ new Date());
if (output !== void 0) process.stdout.write(JSON.stringify(output));
