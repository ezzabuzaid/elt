import { hash } from 'node:crypto';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

import { Declaration } from '@zukhruf/sqlite-drift';
import { open } from '@zukhruf/sqlite-open';
import { transaction } from '@zukhruf/sqlite-transaction';

import {
  type Connection,
  DerivedDataset,
  type RefreshTrigger,
  type Rule,
} from '@eltjs/elt';

import { busyTimeout, openDestination } from './open-destination.ts';
import { SQLiteDestination } from './sqlite-destination.ts';
import type { SQLiteTable } from './sqlite-table.ts';
import { publishSQLiteViews } from './sqlite-views.ts';
import { View } from './view.ts';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

// The columns the dataset keeps on every output row beside the rule's own.
const engineColumns = {
  input_hash:
    'SHA-256 of the input the row was made from; the row is made again when its input changes.',
  rule: 'What made the row, such as the parser of its format or the model; the row is made again when that changes. unsupported: the rule does not handle the input.',
  status:
    'computed: the rule made the row. empty: the rule found nothing to keep, such as a photo without words. failed: the rule failed, error says why, and the refresh after the passes tries again, at most once for each pass.',
  error: 'Why the rule failed. NULL unless status is failed.',
};

type Stored = {
  readonly inputHash: string;
  readonly rule: string;
  readonly status: string;
};

// Data computed on write from what the pipeline's copies load: a rule makes
// one output row for each input, such as the text of each stored file, as
// pgai's vectorizer keeps an embedding beside each row. The pipeline refreshes
// it as its copies commit; each refresh makes the rows whose input or rule
// changed and deletes the rows whose input is gone, and a refresh after the
// passes also tries failed rows again; the passes try each input at most
// once, so a failing rule is asked once a pass.
// A rule's failure on one input is that row's; it never fails the load.
// Readers query the view name, over the table raw_<name>, which a refresh
// replaces when its declaration changes, since it is rebuilt from the inputs.
export class ComputedDataset<
  Input,
  Output extends SQLInputValue,
> extends DerivedDataset<SQLiteTable> {
  readonly name: string;
  readonly #into: SQLiteDestination;
  readonly #description: string;
  readonly #from: readonly (SQLiteTable | View)[];
  readonly #rule: Rule<Input, Output>;
  readonly #table: string;
  readonly #declaration: Declaration;
  // Every column of an output row, in table order.
  readonly #columns: readonly string[];

  constructor({
    into,
    name,
    description,
    from,
    compute,
  }: {
    into: SQLiteDestination;
    name: string;
    description: string;
    from: readonly (SQLiteTable | View)[];
    compute: Rule<Input, Output>;
  }) {
    super();
    this.name = name;
    this.#into = into;
    this.#description = description;
    this.#from = Object.freeze([...from]);
    this.#rule = compute;
    this.#table = `raw_${name}`;
    this.#columns = Object.freeze([
      compute.key.name,
      ...Object.keys(engineColumns),
      ...Object.keys(compute.output),
    ]);
    const ruleColumns = Object.entries(compute.output).map(
      ([column, { type }]) =>
        `${quote(column)} ${type === 'blob' ? 'BLOB' : 'TEXT'}`,
    );
    this.#declaration = new Declaration(
      [
        `CREATE TABLE ${quote(this.#table)} (${[
          `${quote(compute.key.name)} TEXT PRIMARY KEY`,
          '"input_hash" TEXT NOT NULL',
          '"rule" TEXT NOT NULL',
          `"status" TEXT NOT NULL CHECK ("status" IN ('computed', 'empty', 'failed'))`,
          '"error" TEXT',
          ...ruleColumns,
        ].join(', ')}) STRICT`,
      ],
      { rows: 'replace' },
    );
    Object.freeze(this);
  }

  override validate(connections: readonly Connection<SQLiteTable>[]): void {
    for (const target of this.#from)
      if (
        !(target instanceof View) &&
        this.#source(connections, target) === undefined
      )
        throw new TypeError(
          `Computed dataset ${this.name} reads ${target.name}, which no copy of the pipeline loads`,
        );
    const made = connections
      .filter(({ destination }) => this.#same(destination))
      .flatMap(({ steps }) => steps)
      .flatMap(({ to }) => [to.name, to.readerView])
      .filter((name) => name !== undefined)
      .map((name) => name.toLowerCase());
    for (const name of [this.name, this.#table])
      if (made.includes(name.toLowerCase()))
        throw new TypeError(
          `Computed dataset ${this.name} needs ${name}, which a copy of the pipeline makes`,
        );
  }

  override async refresh({
    connections,
    signal,
    trigger,
  }: {
    readonly connections: readonly Connection<SQLiteTable>[];
    readonly signal?: AbortSignal;
    readonly trigger: RefreshTrigger;
  }): Promise<void> {
    const inputs = this.#inputs(connections);
    if (inputs === null) return;
    using database = openDestination(this.#into.path);
    const key = this.#rule.key.name;
    const stored = transaction(
      database,
      () => {
        this.#declaration.apply(database);
        publishSQLiteViews(database, {
          views: [
            {
              name: this.name,
              description: this.#description,
              columns: {
                [key]: this.#rule.key.description,
                ...engineColumns,
                ...Object.fromEntries(
                  Object.entries(this.#rule.output).map(
                    ([column, { description }]) => [column, description],
                  ),
                ),
              },
              query: `SELECT ${this.#columns.map(quote).join(', ')} FROM ${quote(this.#table)}`,
            },
          ],
        });
        const rows = new Map<string, Stored>();
        const remove = database.prepare(
          `DELETE FROM ${quote(this.#table)} WHERE ${quote(key)} = ?`,
        );
        for (const row of database
          .prepare(
            `SELECT ${quote(key)} AS "key", "input_hash", "rule", "status" FROM ${quote(this.#table)}`,
          )
          .all()) {
          const id = String(row.key);
          if (!inputs.has(id)) remove.run(id);
          else
            rows.set(id, {
              inputHash: String(row.input_hash),
              rule: String(row.rule),
              status: String(row.status),
            });
        }
        return rows;
      },
      { mode: 'immediate' },
    );
    const write = database.prepare(
      `INSERT OR REPLACE INTO ${quote(this.#table)} (${this.#columns.map(quote).join(', ')}) VALUES (${this.#columns.map(() => '?').join(', ')})`,
    );
    const store = (
      id: string,
      inputHash: string,
      rule: string,
      status: 'computed' | 'empty' | 'failed',
      error: string | null,
      values: Readonly<Record<string, Output>>,
    ) =>
      write.run(
        id,
        inputHash,
        rule,
        status,
        error,
        ...Object.keys(this.#rule.output).map(
          (column) => values[column] ?? null,
        ),
      );
    const due: {
      readonly id: string;
      readonly input: Input;
      readonly inputHash: string;
      readonly rule: string;
    }[] = [];
    for (const [id, input] of inputs) {
      if (signal?.aborted) return;
      const inputHash = hash('sha256', JSON.stringify(input));
      const rule = await this.#rule.identity(input);
      const before = stored.get(id);
      // A rule that does not handle the input keeps what it made before.
      if (rule === null) {
        if (before?.status === 'computed') continue;
        if (before?.rule === 'unsupported' && before.inputHash === inputHash)
          continue;
        store(id, inputHash, 'unsupported', 'empty', null, {});
        continue;
      }
      if (
        before !== undefined &&
        before.inputHash === inputHash &&
        before.rule === rule
      ) {
        // A failed input waits for the refresh after the passes.
        if (before.status !== 'failed' || trigger.kind === 'commit') continue;
      }
      // The passes try each input, as it is now, at most once: the refresh
      // after them leaves what a commit refresh of the same passes tried.
      const attempt = `${id}\0${inputHash}\0${rule}`;
      if (trigger.tried.has(attempt)) continue;
      if (trigger.kind === 'commit') trigger.tried.add(attempt);
      due.push({ id, input, inputHash, rule });
    }
    // A pool of calls, each taking the next batch once its own committed, so
    // a slow call holds only its place, as a worker pool keeps its other
    // workers busy. A call that fails stops the pool taking more.
    const failures: unknown[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: this.#rule.concurrency }, async () => {
        while (failures.length === 0 && signal?.aborted !== true) {
          const batch = due.slice(next, next + this.#rule.batch);
          next += this.#rule.batch;
          if (batch.length === 0) return;
          let results;
          try {
            results = await this.#rule.compute(
              batch.map(({ input }) => input),
              signal,
            );
          } catch (error) {
            failures.push(error);
            return;
          }
          // Each call commits on its own, so readers see rows as they land.
          transaction(
            database,
            () => {
              batch.forEach(({ id, inputHash, rule }, index) => {
                const result = results[index];
                if (result === undefined || 'gone' in result) return;
                if ('value' in result)
                  store(id, inputHash, rule, 'computed', null, result.value);
                else if ('error' in result)
                  store(id, inputHash, rule, 'failed', result.error, {});
                else store(id, inputHash, rule, 'empty', null, {});
              });
            },
            { mode: 'immediate' },
          );
        }
      }),
    );
    if (failures.length > 0) throw failures[0];
  }

  // Each input by key, from the rows of each relation of from that exists
  // yet: what the copies loaded, or what a view before this dataset gives. A
  // key read twice keeps its first input.
  // null while a relation reads a table that is gone, such as one a person
  // dropped by hand: its copy loads it again, and the dataset waits with what it
  // made, as a view waits. Read as no rows, it would delete every output, and the
  // reload would pay the rule for each again.
  #inputs(
    connections: readonly Connection<SQLiteTable>[],
  ): Map<string, Input> | null {
    const inputs = new Map<string, Input>();
    for (const target of this.#from) {
      const path =
        target instanceof View
          ? target.into.path
          : this.#source(connections, target);
      if (path === undefined) continue;
      using database = open(path, { readOnly: true, timeout: busyTimeout });
      const relation =
        target instanceof View
          ? target.name
          : (target.readerView ?? target.name);
      if (
        database
          .prepare('SELECT 1 FROM sqlite_schema WHERE lower("name") = lower(?)')
          .get(relation) === undefined
      )
        continue;
      let rows: Record<string, SQLOutputValue>[];
      try {
        rows = database.prepare(`SELECT * FROM ${quote(relation)}`).all();
      } catch (error) {
        if (Error.isError(error) && error.message.startsWith('no such table: '))
          return null;
        throw error;
      }
      for (const row of rows) {
        const read = this.#rule.read(row);
        if (read !== null && !inputs.has(read.key))
          inputs.set(read.key, read.input);
      }
    }
    return inputs;
  }

  // The file of the copy of the pipeline that loads target.
  #source(
    connections: readonly Connection<SQLiteTable>[],
    target: SQLiteTable,
  ): string | undefined {
    const connection = connections.find(({ steps }) =>
      steps.some(({ to }) => to === target),
    );
    return connection?.destination instanceof SQLiteDestination
      ? connection.destination.path
      : undefined;
  }

  #same(destination: unknown): boolean {
    return (
      destination instanceof SQLiteDestination &&
      destination.path === this.#into.path
    );
  }
}
