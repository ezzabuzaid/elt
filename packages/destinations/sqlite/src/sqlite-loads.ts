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
    `CREATE TABLE ${loads} ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "connector" TEXT, "dataset" TEXT, "opened_at" TEXT NOT NULL, "closed_at" TEXT, CHECK (("connector" IS NULL) <> ("dataset" IS NULL))) STRICT`,
    `CREATE TABLE ${commits} ("number" INTEGER PRIMARY KEY AUTOINCREMENT, "load" INTEGER NOT NULL REFERENCES ${loads} ("id"), "committed_at" TEXT NOT NULL) STRICT`,
    `CREATE INDEX "_elt_commits_load" ON ${commits} ("load", "number")`,
  ],
  { rows: 'replace' },
);

// What writes a load: a connection's pass, or a refresh of a derived dataset.
// Each runs one at a time, and a name of one never names the other.
export type LoadOwner =
  { readonly connector: string } | { readonly dataset: string };

// One load's connection to its file, and its record there: open from the
// start of the load until it is disposed, with a number for each commit.
export class SQLiteLoad implements Disposable {
  readonly database: DatabaseSync;
  // When the load began, which each row it writes keeps in loaded_at.
  readonly loadedAt: string;
  readonly #id: number;
  readonly #owner: LoadOwner;
  readonly #clock: PipelineClock;

  private constructor(
    database: DatabaseSync,
    id: number,
    loadedAt: string,
    owner: LoadOwner,
    clock: PipelineClock,
  ) {
    this.database = database;
    this.#id = id;
    this.loadedAt = loadedAt;
    this.#owner = owner;
    this.#clock = clock;
  }

  // A connection runs one pass at a time, and a dataset one refresh, so a
  // load of the owner that is still open is one whose process ended during
  // it: the new load closes it, as the sync history of a sole writer fails
  // such a pass.
  static open(
    path: string,
    owner: LoadOwner,
    clock: PipelineClock,
  ): SQLiteLoad {
    const database = openDestination(path);
    const loadedAt = now(clock);
    try {
      const id = transaction(
        database,
        () => {
          const id = begin(database, owner, loadedAt);
          const [column, name] = owned(owner);
          database
            .prepare(
              `UPDATE ${loads} SET "closed_at" = ? WHERE ${column} = ? AND "closed_at" IS NULL AND "id" <> ?`,
            )
            .run(loadedAt, name, id);
          return id;
        },
        { mode: 'immediate' },
      );
      return new SQLiteLoad(database, id, loadedAt, owner, clock);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  // The number of a change that is a load of one commit, such as a clear,
  // taken inside the caller's transaction: the load opens, commits and
  // closes in it. It is not a pass, so it leaves the open loads of its
  // connection open, and a pass that has commits before and after it keeps it
  // from being a position until that pass ends.
  static once(
    database: DatabaseSync,
    connection: string,
    clock: PipelineClock,
  ): number {
    const at = now(clock);
    const id = begin(database, { connector: connection }, at);
    const committed = Number(
      database
        .prepare(
          `INSERT INTO ${commits} ("load", "committed_at") VALUES (?, ?) RETURNING "number"`,
        )
        .get(id, at)?.number,
    );
    database
      .prepare(`UPDATE ${loads} SET "closed_at" = ? WHERE "id" = ?`)
      .run(at, id);
    return committed;
  }

  // The number of a commit of this load, taken inside the commit's
  // transaction: SQLite runs one write transaction at a time, so the numbers
  // follow the order of the commits. A load that a later load of its
  // owner closed has ended, and a commit after its end would move a
  // position that readers were already given.
  commit(): number {
    const row = this.database
      .prepare(
        `INSERT INTO ${commits} ("load", "committed_at") SELECT "id", ? FROM ${loads} WHERE "id" = ? AND "closed_at" IS NULL RETURNING "number"`,
      )
      .get(now(this.#clock), this.#id);
    if (row === undefined)
      throw new Error(
        'connector' in this.#owner
          ? `A later load of connection ${this.#owner.connector} closed this load, so it cannot commit; a connection runs one pass at a time`
          : `A later refresh of dataset ${this.#owner.dataset} closed this one, so it cannot commit; a dataset refreshes one at a time`,
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

// Records a load of owner that opens at openedAt, with the numbering and
// its epoch if the file has none yet, and gives its id.
function begin(
  database: DatabaseSync,
  owner: LoadOwner,
  openedAt: string,
): number {
  const [column, name] = owned(owner);
  numbering.apply(database);
  database
    .prepare(
      `INSERT INTO ${epochs} ("id", "epoch") VALUES (1, ?) ON CONFLICT DO NOTHING`,
    )
    .run(randomUUID());
  return Number(
    database
      .prepare(
        `INSERT INTO ${loads} (${column}, "opened_at") VALUES (?, ?) RETURNING "id"`,
      )
      .get(name, openedAt)?.id,
  );
}

// The column of _elt_loads that names owner, and its name there.
function owned(owner: LoadOwner): readonly [string, string] {
  return 'connector' in owner
    ? ['"connector"', owner.connector]
    : ['"dataset"', owner.dataset];
}

// The numbering of a file, as one snapshot reads it.
export type Numbering = {
  readonly epoch: string;
  // The number of the newest commit, 0 before the first.
  readonly newest: number;
  // The commits that are positions, ascending.
  readonly ends: readonly number[];
};

// A position, as `${epoch}:${number}` names it.
export type Position = { readonly epoch: string; readonly number: number };

// The positions of the file after `after`, ascending; all of them when
// after is undefined. database is null while no file is at the path.
export function positionsAfter(
  database: DatabaseSync | null,
  after: string | undefined,
): readonly string[] | { readonly expired: string } {
  const since = after === undefined ? undefined : parsePosition(after);
  const numbered =
    database === null
      ? null
      : transaction(database, () => readNumbering(database), {
          mode: 'deferred',
        });
  if (since === undefined)
    return numbered === null
      ? []
      : numbered.ends.map((end) => `${numbered.epoch}:${end}`);
  const expired = expiry(numbered, since);
  if (expired !== undefined) return { expired };
  return (numbered?.ends ?? [])
    .filter((end) => end > since.number)
    .map((end) => `${since.epoch}:${end}`);
}

// Why a position is not one of the file's commits, or undefined when it is.
export function expiry(
  numbered: Numbering | null,
  { epoch, number }: Position,
): string | undefined {
  const position = `${epoch}:${number}`;
  if (numbered === null)
    return `Position ${position} is of commits this file does not have`;
  if (epoch !== numbered.epoch)
    return `Position ${position} is of an earlier numbering: the commits of this file were numbered again since`;
  if (number > numbered.newest)
    return `Position ${position} is past the newest commit of this file, ${numbered.newest}`;
  return undefined;
}

// The numbering of the file, as the snapshot of the open read transaction
// reads it, or null when the file has none. A position is a commit that ends
// a closed load where no load straddles it, so a reader there sees no part
// of a pass. A sweep line finds them: taking the loads in order of their
// first commits, an end is a position when no load that began at or before
// it ends after it. An open load has no end yet, so it reaches past every
// later commit.
export function readNumbering(database: DatabaseSync): Numbering | null {
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

// When a commit of the file was made, or undefined when it has no commit of
// that number.
export function committedAt(
  database: DatabaseSync,
  number: number,
): string | undefined {
  const at = database
    .prepare(`SELECT "committed_at" FROM ${commits} WHERE "number" = ?`)
    .get(number)?.committed_at;
  return typeof at === 'string' ? at : undefined;
}

export function parsePosition(position: string): Position {
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
