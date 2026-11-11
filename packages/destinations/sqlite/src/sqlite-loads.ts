import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { Declaration } from '@zukhruf/sqlite-drift';
import { transaction } from '@zukhruf/sqlite-transaction';

import type { PipelineClock } from '@eltjs/elt';

import { openDestination } from './open-destination.ts';

const epochs = '"_elt_epoch"';
const loads = '"_elt_loads"';
const commits = '"_elt_commits"';

// How the file numbers its commits. The epoch names the numbering: it is
// made with the tables, so a file made again, or tables another version
// declared otherwise, start a numbering of their own.
const numbering = new Declaration(
  [
    `CREATE TABLE ${epochs} ("id" INTEGER PRIMARY KEY CHECK ("id" = 1), "epoch" TEXT NOT NULL) STRICT`,
    `CREATE TABLE ${loads} ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "connector" TEXT NOT NULL, "opened_at" TEXT NOT NULL, "closed_at" TEXT) STRICT`,
    `CREATE TABLE ${commits} ("number" INTEGER PRIMARY KEY AUTOINCREMENT, "load" INTEGER NOT NULL REFERENCES ${loads} ("id"), "committed_at" TEXT NOT NULL) STRICT`,
    `CREATE INDEX "_elt_commits_load" ON ${commits} ("load", "number")`,
  ],
  { rows: 'replace' },
);

// One load's connection to its file, and its record there: open from the
// start of the load until it is disposed, with a number for each commit.
export class SQLiteLoad implements Disposable {
  readonly database: DatabaseSync;
  // When the load began, which each row it writes keeps in loaded_at.
  readonly loadedAt: string;
  readonly #id: number;
  readonly #connection: string;
  readonly #clock: PipelineClock;

  private constructor(
    database: DatabaseSync,
    id: number,
    loadedAt: string,
    connection: string,
    clock: PipelineClock,
  ) {
    this.database = database;
    this.#id = id;
    this.loadedAt = loadedAt;
    this.#connection = connection;
    this.#clock = clock;
  }

  // A connection runs one pass at a time, so a load of it that is still open
  // is one whose process ended during its pass: the new load closes it, as
  // the sync history of a sole writer fails such a pass.
  static open(
    path: string,
    connection: string,
    clock: PipelineClock,
  ): SQLiteLoad {
    const database = openDestination(path);
    const loadedAt = now(clock);
    try {
      const id = transaction(
        database,
        () => {
          numbering.apply(database);
          database
            .prepare(
              `INSERT INTO ${epochs} ("id", "epoch") VALUES (1, ?) ON CONFLICT DO NOTHING`,
            )
            .run(randomUUID());
          database
            .prepare(
              `UPDATE ${loads} SET "closed_at" = ? WHERE "connector" = ? AND "closed_at" IS NULL`,
            )
            .run(loadedAt, connection);
          return Number(
            database
              .prepare(
                `INSERT INTO ${loads} ("connector", "opened_at") VALUES (?, ?) RETURNING "id"`,
              )
              .get(connection, loadedAt)?.id,
          );
        },
        { mode: 'immediate' },
      );
      return new SQLiteLoad(database, id, loadedAt, connection, clock);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  // The number of a commit of this load, taken inside the commit's
  // transaction: SQLite runs one write transaction at a time, so the numbers
  // follow the order of the commits. A load that a later load of its
  // connection closed has ended, and a commit after its end would move a
  // position that readers were already given.
  commit(): number {
    const row = this.database
      .prepare(
        `INSERT INTO ${commits} ("load", "committed_at") SELECT "id", ? FROM ${loads} WHERE "id" = ? AND "closed_at" IS NULL RETURNING "number"`,
      )
      .get(now(this.#clock), this.#id);
    if (row === undefined)
      throw new Error(
        `A later load of connection ${this.#connection} closed this load, so it cannot commit; a connection runs one pass at a time`,
      );
    return Number(row.number);
  }

  [Symbol.dispose](): void {
    try {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      transaction(
        this.database,
        () =>
          this.database
            .prepare(
              `UPDATE ${loads} SET "closed_at" = ? WHERE "id" = ? AND "closed_at" IS NULL`,
            )
            .run(now(this.#clock), this.#id),
        { mode: 'immediate' },
      );
    } finally {
      this.database.close();
    }
  }
}

// The positions of the file after `after`, ascending; all of them when
// after is undefined. database is null while no file is at the path.
export function positionsAfter(
  database: DatabaseSync | null,
  after: string | undefined,
): readonly string[] | { readonly expired: string } {
  const since = after === undefined ? undefined : parse(after);
  const numbered =
    database === null
      ? null
      : transaction(database, () => read(database), { mode: 'deferred' });
  if (numbered === null)
    return since === undefined
      ? []
      : { expired: `Position ${after} is of commits this file does not have` };
  const { epoch, newest, ends } = numbered;
  if (since !== undefined) {
    if (since.epoch !== epoch)
      return {
        expired: `Position ${after} is of an earlier numbering: the commits of this file were numbered again since`,
      };
    if (since.number > newest)
      return {
        expired: `Position ${after} is past the newest commit of this file, ${newest}`,
      };
  }
  const later =
    since === undefined ? ends : ends.filter((end) => end > since.number);
  return later.map((end) => `${epoch}:${end}`);
}

// The numbering of the file, as one snapshot reads it, or null when the file
// has none. A position is a commit that ends a closed load where no load
// straddles it, so a reader there sees no part of a pass. A sweep line finds
// them: taking the loads in order of their first commits, an end is a
// position when no load that began at or before it ends after it. An open
// load has no end yet, so it reaches past every later commit.
function read(
  database: DatabaseSync,
): { epoch: string; newest: number; ends: number[] } | null {
  if (numbering.drift(database) !== 'fits') return null;
  const epoch = database.prepare(`SELECT "epoch" FROM ${epochs}`).get()?.epoch;
  if (typeof epoch !== 'string') return null;
  const newest = Number(
    database
      .prepare(`SELECT coalesce(max("number"), 0) AS "newest" FROM ${commits}`)
      .get()?.newest,
  );
  const spans = database
    .prepare(
      `SELECT min(c."number") AS "first", CASE WHEN l."closed_at" IS NULL THEN NULL ELSE max(c."number") END AS "last" FROM ${commits} AS c JOIN ${loads} AS l ON l."id" = c."load" GROUP BY l."id" ORDER BY "first"`,
    )
    .all()
    .map((span) => ({
      first: Number(span.first),
      last: span.last === null ? Infinity : Number(span.last),
    }));
  const ends: number[] = [];
  const pending = spans.values();
  let span = pending.next();
  let reach = 0;
  for (const end of spans
    .map(({ last }) => last)
    .filter(Number.isFinite)
    .sort((left, right) => left - right)) {
    for (; !span.done && span.value.first <= end; span = pending.next())
      reach = Math.max(reach, span.value.last);
    if (reach === end) ends.push(end);
  }
  return { epoch, newest, ends };
}

function parse(position: string): { epoch: string; number: number } {
  const groups = /^(?<epoch>[^:]+):(?<number>0|[1-9]\d*)$/.exec(
    position,
  )?.groups;
  if (groups?.epoch === undefined || groups.number === undefined)
    throw new TypeError(`${position} is not a position of a SQLite file`);
  return { epoch: groups.epoch, number: Number(groups.number) };
}

function now(clock: PipelineClock): string {
  return new Date(clock.Date.now()).toISOString();
}
