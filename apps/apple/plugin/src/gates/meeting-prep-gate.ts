import { AppleImports } from '../apple-imports.ts';
import { CalendarImport } from '../calendar-import.ts';
import { ProactiveStore } from '../proactive-store.ts';
import { HeartbeatGate, type Section, type Work } from './heartbeat-gate.ts';

// With a check every ten minutes, each meeting is prepared 30 to 40 minutes
// before it starts.
const leadMinutes = 40;

// The Meeting prep heartbeat: hands each meeting coming due to the model once,
// to brief in a chat of its own, and tells a meeting's chat when Calendar
// moves or cancels the meeting.
export class MeetingPrepGate extends HeartbeatGate {
  protected readonly skill = 'meeting-prep';

  protected due(directory: string, now: Date): Work {
    const database = new AppleImports(directory).database('calendar');
    if (database === null) return { quiet: 'Calendar is not imported.' };
    const calendar = new CalendarImport(database);
    using store = new ProactiveStore(directory);
    const handed = store.meetings();
    const known = new Set(handed.map(({ eventId }) => eventId));
    const fresh = calendar
      .due(now, new Date(now.getTime() + leadMinutes * 60_000))
      .filter(({ eventId }) => !known.has(eventId));
    const briefed = handed.filter(
      ({ threadId, cancelled }) => threadId !== null && !cancelled,
    );
    const current = new Map(
      calendar
        .occurrences(briefed.map(({ eventId }) => eventId))
        .map((occurrence) => [occurrence.eventId, occurrence]),
    );
    const moved = [];
    const cancelled = [];
    for (const meeting of briefed) {
      const occurrence = current.get(meeting.eventId);
      if (occurrence === undefined || occurrence.cancelled)
        cancelled.push(meeting);
      else if (
        occurrence.startAt !== meeting.startAt &&
        occurrence.startAt >= now.toISOString()
      )
        moved.push({ ...meeting, ...occurrence });
    }

    store.hand(fresh);
    for (const meeting of moved) store.move(meeting);
    for (const { eventId } of cancelled) store.cancel(eventId);
    const sections: Section[] = [];
    if (fresh.length > 0)
      sections.push({
        title: `New meetings, found in the Calendar import "${database}"`,
        items: fresh.map((meeting) => ({
          ...meeting,
          attendees: meeting.attendees.map((attendee) => ({
            ...attendee,
            note: store.note(attendee.email.toLowerCase()),
          })),
        })),
      });
    if (moved.length > 0)
      sections.push({
        title: 'Moved meetings',
        items: moved.map(({ threadId, name, startAt, endAt }) => ({
          threadId,
          name,
          startAt,
          endAt,
        })),
      });
    if (cancelled.length > 0)
      sections.push({
        title: 'Cancelled meetings',
        items: cancelled.map(({ threadId, name, startAt }) => ({
          threadId,
          name,
          startAt,
        })),
      });
    return sections.length > 0
      ? { sections }
      : { quiet: 'No meeting to prepare yet.' };
  }
}
