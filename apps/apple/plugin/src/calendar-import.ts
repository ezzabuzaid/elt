import { readSQLite } from '@workspace/elt-sqlite';

import type { Person } from './proactive-store.ts';

// Calendar's import, read-only and waiting while a pass commits, for the
// heartbeat gates: which meetings come due, what became of the meetings
// already handed over, and who the user meets.

// An attendee who is another person: not the user, not a room, and not one
// of Google Calendar's own addresses, such as the stand-in organizer it lists
// on events it imported.
const otherPerson = `a.isCurrentUser = 0 AND a.type IS NOT 2 AND a.url NOT LIKE '%calendar.google.com'`;

// A meeting as $meeting-prep defines one, worth preparing only with someone
// else invited or a link to join, and not declined. Work blocks and classes
// on the user's own calendar have neither.
const dueMeetings = `SELECT e.eventId, e.name, e.startAt, e.endAt, c.name AS calendar, e.location, e.url, e.body, e.externalId,
    (SELECT json_group_array(json_object('name', a.name, 'email', substr(a.url, 8), 'kind', a.kind, 'status', a.status, 'role', a.role))
       FROM attendees a WHERE a.eventId = e.eventId AND ${otherPerson}) AS attendees
  FROM events e JOIN calendars c ON c.id = e.calendarId
  WHERE e.allDay = 0 AND e.status IS NOT 3
    AND e.startAt >= @from AND e.startAt < @until
    AND ((c.subscribed = 0 AND c.type IN (0, 1, 2)) OR EXISTS (SELECT 1 FROM attendees a WHERE a.eventId = e.eventId))
    AND NOT EXISTS (SELECT 1 FROM attendees a WHERE a.eventId = e.eventId AND a.isCurrentUser = 1 AND a.status = 3)
    AND (EXISTS (SELECT 1 FROM attendees a WHERE a.eventId = e.eventId AND ${otherPerson})
      OR e.url IS NOT NULL OR e.location LIKE '%://%' OR e.body LIKE '%://%')
  ORDER BY e.startAt`;

// The other people invited to the user's meetings in a window, by email.
const peopleMet = `SELECT lower(substr(a.url, 8)) AS email, max(a.name) AS name
  FROM attendees a JOIN events e ON e.eventId = a.eventId
  WHERE ${otherPerson} AND a.url LIKE 'mailto:%'
    AND e.status IS NOT 3 AND e.startAt >= @from AND e.startAt < @until
  GROUP BY lower(substr(a.url, 8)) ORDER BY min(e.startAt)`;

export type MeetingRow = {
  eventId: string;
  name: string;
  startAt: string;
  endAt: string;
  calendar: string;
  location: string | null;
  url: string | null;
  body: string | null;
  externalId: string | null;
  attendees: { name: string | null; email: string }[];
};

export type Occurrence = {
  eventId: string;
  startAt: string;
  endAt: string;
  cancelled: boolean;
};

const text = (value: unknown) =>
  value === null || value === undefined ? null : String(value);

export class CalendarImport {
  readonly database: string;

  constructor(database: string) {
    this.database = database;
  }

  #all(sql: string, parameters: Record<string, string>) {
    using reader = readSQLite(this.database);
    return reader.prepare(sql).all(parameters);
  }

  due(from: Date, until: Date): MeetingRow[] {
    return this.#all(dueMeetings, {
      from: from.toISOString(),
      until: until.toISOString(),
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
      attendees: JSON.parse(String(row.attendees)),
    }));
  }

  // The current state of the given occurrences; one missing from the result
  // was deleted.
  occurrences(eventIds: readonly string[]): Occurrence[] {
    if (eventIds.length === 0) return [];
    return this.#all(
      `SELECT eventId, startAt, endAt, status FROM events WHERE eventId IN (SELECT value FROM json_each(@ids))`,
      { ids: JSON.stringify(eventIds) },
    ).map((row) => ({
      eventId: String(row.eventId),
      startAt: String(row.startAt),
      endAt: String(row.endAt),
      cancelled: row.status === 3,
    }));
  }

  peopleMet(from: Date, until: Date): Person[] {
    return this.#all(peopleMet, {
      from: from.toISOString(),
      until: until.toISOString(),
    }).map((row) => ({
      email: String(row.email),
      name: text(row.name) ?? String(row.email),
    }));
  }
}
