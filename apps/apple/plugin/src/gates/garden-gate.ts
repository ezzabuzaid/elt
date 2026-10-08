import { existsSync } from 'node:fs';

import { AppleImports } from '../apple-imports.ts';
import { CalendarImport } from '../calendar-import.ts';
import { ProactiveStore } from '../proactive-store.ts';
import { HeartbeatGate, type Section, type Work } from './heartbeat-gate.ts';

const minute = 60_000;
const day = 24 * 60 * minute;

// A meeting's chat stays open this long after the meeting ends.
const archiveAfter = 60 * minute;
// A person's note is refreshed when it is older than this.
const noteAge = 7 * day;
// People asked for once are not asked for again before this, so a run that
// failed is retried the next day, not every hour.
const noteRetry = day;
// People handed over per run. The rest come in later runs, so every person
// gets a note.
const notesPerRun = 5;
// A meeting's record is kept this long after the meeting ends.
const recordRetention = 30 * day;

const before = (now: Date, ms: number) =>
  new Date(now.getTime() - ms).toISOString();

// The Apple gardener heartbeat: archives meeting chats once their meeting is
// over, reports each import problem once, keeps a note about each person the
// user meets, and tidies the plugin's records itself.
export class GardenGate extends HeartbeatGate {
  protected readonly skill = 'garden-apple';

  protected due(directory: string, now: Date): Work {
    if (!existsSync(directory)) return { quiet: 'Apple is not set up.' };
    const imports = new AppleImports(directory);
    const database = imports.database('calendar');
    const calendar = database === null ? null : new CalendarImport(database);
    using store = new ProactiveStore(directory);
    const sections = [
      chatsToArchive(store, calendar, now),
      problemsToReport(store, imports),
      calendar === null ? null : peopleToNote(store, calendar, now),
    ].filter((section) => section !== null);
    store.prune(before(now, recordRetention));
    return sections.length > 0 ? { sections } : { quiet: 'Nothing to tend.' };
  }
}

// Calendar decides when a meeting is over: it may have moved, been cancelled
// or deleted since it was handed over.
function chatsToArchive(
  store: ProactiveStore,
  calendar: CalendarImport | null,
  now: Date,
): Section | null {
  const open = store.openChats();
  const current = new Map(
    (calendar?.occurrences(open.map(({ eventId }) => eventId)) ?? []).map(
      (occurrence) => [occurrence.eventId, occurrence],
    ),
  );
  const over = open.filter(({ eventId, endAt, cancelled }) => {
    if (cancelled) return true;
    if (calendar === null) return endAt <= before(now, archiveAfter);
    const occurrence = current.get(eventId);
    return (
      occurrence === undefined ||
      occurrence.cancelled ||
      occurrence.endAt <= before(now, archiveAfter)
    );
  });
  if (over.length === 0) return null;
  store.archiveHanded(
    over.map(({ eventId }) => eventId),
    now.toISOString(),
  );
  return {
    title: 'Meeting chats to archive',
    items: over.map(({ threadId, name, startAt }) => ({
      threadId,
      name,
      startAt,
    })),
  };
}

function problemsToReport(
  store: ProactiveStore,
  imports: AppleImports,
): Section | null {
  const problems = imports.problems().map((problem) => ({
    ...problem,
    key: `${problem.connector}\n${problem.problem}`,
  }));
  const reported = store.reported();
  const unreported = problems.filter(({ key }) => !reported.has(key));
  store.keepReports(problems.map(({ key }) => key));
  if (unreported.length === 0) return null;
  return {
    title: 'Import problems to report',
    items: unreported.map(({ connector, problem, permissions }) => ({
      connector,
      problem,
      permissions,
    })),
  };
}

function peopleToNote(
  store: ProactiveStore,
  calendar: CalendarImport,
  now: Date,
): Section | null {
  const people = store
    .notesDue(
      calendar.peopleMet(
        new Date(now.getTime() - 30 * day),
        new Date(now.getTime() + 7 * day),
      ),
      {
        staleBefore: before(now, noteAge),
        requestedBefore: before(now, noteRetry),
      },
    )
    .slice(0, notesPerRun);
  if (people.length === 0) return null;
  store.requestNotes(people, now.toISOString());
  return { title: 'People to write notes about', items: people };
}
