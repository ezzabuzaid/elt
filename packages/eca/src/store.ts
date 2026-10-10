import { DatabaseSync } from 'node:sqlite';

import type { Reads } from './imports.ts';

// What eca remembers of each rule between processes: the keys its condition
// matched, each with its data as JSON, and the tables the condition read.
// Stored data is disposable, so a store of another layout starts empty.
const layout = 1;

export class Store implements Disposable {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path, { timeout: 30_000 });
    if (
      this.#database.prepare('PRAGMA user_version').get()?.user_version !==
      layout
    )
      this.#database.exec(
        `DROP TABLE IF EXISTS rules; DROP TABLE IF EXISTS matches; DROP TABLE IF EXISTS reads; PRAGMA user_version = ${layout};`,
      );
    this.#database.exec(
      `CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY);
       CREATE TABLE IF NOT EXISTS matches (rule TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (rule, key));
       CREATE TABLE IF NOT EXISTS reads (rule TEXT NOT NULL, import TEXT NOT NULL, "table" TEXT NOT NULL, PRIMARY KEY (rule, import, "table"));`,
    );
  }

  has(rule: string): boolean {
    return (
      this.#database.prepare('SELECT 1 FROM rules WHERE id = ?').get(rule) !==
      undefined
    );
  }

  matches(rule: string): Map<string, string> {
    return new Map(
      this.#database
        .prepare('SELECT key, data FROM matches WHERE rule = ?')
        .all(rule)
        .map(({ key, data }) => [String(key), String(data)]),
    );
  }

  reads(rule: string): Reads {
    const reads = new Map<string, Set<string>>();
    for (const read of this.#database
      .prepare('SELECT import, "table" FROM reads WHERE rule = ?')
      .all(rule)) {
      const name = String(read.import);
      reads.set(name, (reads.get(name) ?? new Set()).add(String(read.table)));
    }
    return reads;
  }

  save(rule: string, matches: ReadonlyMap<string, string>, reads: Reads): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database
        .prepare('INSERT OR IGNORE INTO rules (id) VALUES (?)')
        .run(rule);
      this.#database.prepare('DELETE FROM matches WHERE rule = ?').run(rule);
      this.#database.prepare('DELETE FROM reads WHERE rule = ?').run(rule);
      const match = this.#database.prepare(
        'INSERT INTO matches (rule, key, data) VALUES (?, ?, ?)',
      );
      for (const [key, data] of matches) match.run(rule, key, data);
      const read = this.#database.prepare(
        'INSERT INTO reads (rule, import, "table") VALUES (?, ?, ?)',
      );
      for (const [name, tables] of reads)
        for (const table of tables) read.run(rule, name, table);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}
