import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import { appleDirectory } from './apple-directory.ts';

// The Meeting prep heartbeat's gate, run by hooks/meeting-prep-gate before the
// heartbeat reaches the model. ChatGPT wakes that chat every ten minutes; a
// wake with no meeting to prepare is blocked, so the model never runs and the
// chat shows nothing. A wake with meetings due hands them to the model, once
// each, and the model briefs them with $meeting-prep.

// With a check every ten minutes, each meeting is prepared 30 to 40 minutes
// before it starts.
const leadMinutes = 40;

// A meeting as $meeting-prep defines one, worth preparing only with someone
// else invited or a link to join, and not declined. Work blocks and classes
// on the user's own calendar have neither.
const dueMeetings = `SELECT e.eventId, e.name, e.startAt, e.endAt, c.name AS calendar, e.location, e.url, e.body, e.externalId,
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

// The occurrences already handed to the model; a moved meeting is a new one.
const handedSchema = z.array(
  z.strictObject({ eventId: z.string(), startAt: z.string() }),
);

// Codex's UserPromptSubmit output: block the turn, or let it run with context.
function gate(prompt: string, now: Date): object | undefined {
  const instructions =
    /^<heartbeat>[\s\S]*?<instructions>([\s\S]*?)<\/instructions>/.exec(
      prompt,
    )?.[1];
  if (!instructions?.includes('$meeting-prep')) return undefined;

  const directory = appleDirectory();
  const settingsFile = join(directory, 'settings.sqlite');
  if (!existsSync(settingsFile)) return block('Apple is not set up.');
  const calendar = (() => {
    using settings = new DatabaseSync(settingsFile, { readOnly: true });
    return settings
      .prepare(
        "SELECT database FROM selected_connectors WHERE connector = 'calendar'",
      )
      .get()?.database;
  })();
  if (typeof calendar !== 'string' || !existsSync(calendar))
    return block('Calendar is not imported.');

  const meetings = (() => {
    using database = new DatabaseSync(calendar, { readOnly: true });
    return database.prepare(dueMeetings).all({
      from: now.toISOString(),
      until: new Date(now.getTime() + leadMinutes * 60_000).toISOString(),
    });
  })();
  const ledger = join(directory, 'meeting-prep.json');
  const handed = existsSync(ledger)
    ? handedSchema.parse(JSON.parse(readFileSync(ledger, 'utf8')))
    : [];
  const due = meetings.filter(
    ({ eventId, startAt }) =>
      !handed.some(
        (meeting) => meeting.eventId === eventId && meeting.startAt === startAt,
      ),
  );
  if (due.length === 0) return block('No meeting to prepare yet.');

  // A meeting that started can no longer come due, so it is forgotten.
  const kept = [
    ...handed.filter(({ startAt }) => startAt >= now.toISOString()),
    ...due.map(({ eventId, startAt }) => ({
      eventId: String(eventId),
      startAt: String(startAt),
    })),
  ];
  writeFileSync(`${ledger}.tmp`, JSON.stringify(kept));
  renameSync(`${ledger}.tmp`, ledger);
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: [
        `The Apple plugin hands you these meetings to prepare now, found in the Calendar import "${calendar}". Brief each with $meeting-prep from its step 2: each row below is that meeting's step 1 result.`,
        JSON.stringify(due),
      ].join('\n'),
    },
  };
}

function block(reason: string) {
  return { decision: 'block', reason };
}

const { prompt } = z
  .object({ prompt: z.string() })
  .parse(JSON.parse(readFileSync(0, 'utf8')));
const output = gate(prompt, new Date());
if (output !== undefined) process.stdout.write(JSON.stringify(output));
