import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// What the proactive agent remembers between heartbeats, beside the imports:
// each meeting handed to Meeting prep and the chat that briefs it, the note
// kept about each person, and the import problems already reported. The
// heartbeat gates and the plugin's tools share it from separate processes.
// Stored data is disposable, so a newer layout starts it empty.
const layout = 1;

export type Meeting = {
  eventId: string;
  name: string;
  startAt: string;
  endAt: string;
};

export type HandedMeeting = Meeting & {
  threadId: string | null;
  cancelled: boolean;
};

export type Person = { email: string; name: string };

export class ProactiveStore implements Disposable {
  readonly #database: DatabaseSync;

  constructor(directory: string) {
    this.#database = new DatabaseSync(join(directory, 'proactive.sqlite'), {
      timeout: 30_000,
    });
    try {
      const version = this.#database.prepare('PRAGMA user_version').get();
      if (Number(version?.user_version) !== layout)
        this.#database.exec(
          `DROP TABLE IF EXISTS meetings; DROP TABLE IF EXISTS people; DROP TABLE IF EXISTS reports; PRAGMA user_version = ${layout};`,
        );
      this.#database.exec(
        `CREATE TABLE IF NOT EXISTS meetings (event_id TEXT PRIMARY KEY, name TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL, thread_id TEXT, cancelled INTEGER NOT NULL DEFAULT 0, archive_handed_at TEXT);
         CREATE TABLE IF NOT EXISTS people (email TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT, noted_at TEXT, requested_at TEXT);
         CREATE TABLE IF NOT EXISTS reports (key TEXT PRIMARY KEY);`,
      );
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  meetings(): HandedMeeting[] {
    return this.#select('');
  }

  #select(where: string, ...values: string[]): HandedMeeting[] {
    return this.#database
      .prepare(
        `SELECT event_id, name, start_at, end_at, thread_id, cancelled FROM meetings ${where}`,
      )
      .all(...values)
      .map((row) => ({
        eventId: String(row.event_id),
        name: String(row.name),
        startAt: String(row.start_at),
        endAt: String(row.end_at),
        threadId: row.thread_id === null ? null : String(row.thread_id),
        cancelled: row.cancelled === 1,
      }));
  }

  hand(meetings: readonly Meeting[]): void {
    const insert = this.#database.prepare(
      'INSERT OR IGNORE INTO meetings (event_id, name, start_at, end_at) VALUES (?, ?, ?, ?)',
    );
    for (const { eventId, name, startAt, endAt } of meetings)
      insert.run(eventId, name, startAt, endAt);
  }

  move({ eventId, startAt, endAt }: Meeting): void {
    this.#database
      .prepare(
        'UPDATE meetings SET start_at = ?, end_at = ?, archive_handed_at = NULL WHERE event_id = ?',
      )
      .run(startAt, endAt, eventId);
  }

  cancel(eventId: string): void {
    this.#database
      .prepare('UPDATE meetings SET cancelled = 1 WHERE event_id = ?')
      .run(eventId);
  }

  // Refuses a meeting the gate never handed over, so a mistyped id is not
  // silently kept.
  recordChat(eventId: string, threadId: string): void {
    const { changes } = this.#database
      .prepare('UPDATE meetings SET thread_id = ? WHERE event_id = ?')
      .run(threadId, eventId);
    if (changes === 0)
      throw new Error(
        `No meeting with eventId ${eventId} was handed over by Meeting prep.`,
      );
  }

  // Meetings whose chat is not yet handed over for archiving.
  openChats(): HandedMeeting[] {
    return this.#select(
      'WHERE thread_id IS NOT NULL AND archive_handed_at IS NULL',
    );
  }

  archiveHanded(eventIds: readonly string[], at: string): void {
    const update = this.#database.prepare(
      'UPDATE meetings SET archive_handed_at = ? WHERE event_id = ?',
    );
    for (const eventId of eventIds) update.run(at, eventId);
  }

  // People whose note is missing or older than staleBefore, and who were not
  // already requested since requestedBefore.
  notesDue(
    people: readonly Person[],
    {
      staleBefore,
      requestedBefore,
    }: { staleBefore: string; requestedBefore: string },
  ): Person[] {
    const row = this.#database.prepare(
      'SELECT noted_at, requested_at FROM people WHERE email = ?',
    );
    return people.filter(({ email }) => {
      const known = row.get(email);
      if (known === undefined) return true;
      const noted = known.noted_at === null ? null : String(known.noted_at);
      const requested =
        known.requested_at === null ? null : String(known.requested_at);
      return (
        (noted === null || noted < staleBefore) &&
        (requested === null || requested < requestedBefore)
      );
    });
  }

  requestNotes(people: readonly Person[], at: string): void {
    const upsert = this.#database.prepare(
      'INSERT INTO people (email, name, requested_at) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name, requested_at = excluded.requested_at',
    );
    for (const { email, name } of people) upsert.run(email, name, at);
  }

  saveNote({ email, name }: Person, note: string, at: string): void {
    this.#database
      .prepare(
        'INSERT INTO people (email, name, note, noted_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name, note = excluded.note, noted_at = excluded.noted_at',
      )
      .run(email, name, note, at);
  }

  note(email: string): string | null {
    const row = this.#database
      .prepare('SELECT note FROM people WHERE email = ?')
      .get(email);
    return row?.note === undefined || row.note === null
      ? null
      : String(row.note);
  }

  reported(): Set<string> {
    return new Set(
      this.#database
        .prepare('SELECT key FROM reports')
        .all()
        .map(({ key }) => String(key)),
    );
  }

  // Keeps exactly the problems still open, so one that clears and comes back
  // is reported again.
  keepReports(open: readonly string[]): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.exec('DELETE FROM reports');
      const insert = this.#database.prepare(
        'INSERT INTO reports (key) VALUES (?)',
      );
      for (const key of open) insert.run(key);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  // Forgets meetings that ended long ago; their chats were handed for
  // archiving when they ended.
  prune(endedBefore: string): void {
    this.#database
      .prepare('DELETE FROM meetings WHERE end_at < ?')
      .run(endedBefore);
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}
