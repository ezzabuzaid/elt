import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type postgres from 'postgres';

import { Eca, type Rule, type Warehouse } from '@eltjs/eca';

import type { Automation } from './automation.ts';

type Command = (signal: AbortSignal) => Promise<string>;

// An automation as an eca rule, named for its saved cursor.
type Named = Rule<postgres.Sql, Command> & { readonly name: string };

// Runs the automations over one warehouse. An automation gives the keys that
// are true; its eca condition gives each key that is true after and was not
// before, carrying the automation's act bound to the match, so a new match is
// a command the loop runs, and eca stays unaware of actions. The cursor of
// each automation is kept in proactive.cursors, by the name it was added
// with, so a restart goes on where the last run stopped.
export class Automations {
  readonly #eca: Eca<postgres.Sql, Command>;
  readonly #cursors: postgres.Sql;
  readonly #osascript: string;
  readonly #rules = new Map<string, Named>();

  constructor({
    warehouse,
    cursors,
    osascript = '/usr/bin/osascript',
  }: {
    warehouse: Warehouse<postgres.Sql>;
    // A session that may write the cursors' table.
    cursors: postgres.Sql;
    osascript?: string;
  }) {
    this.#eca = new Eca({ warehouse, clock: globalThis });
    this.#cursors = cursors;
    this.#osascript = osascript;
  }

  add<Data>(name: string, automation: Automation<Data>): void {
    if (this.#rules.has(name))
      throw new TypeError(`An automation named ${name} was already added`);
    this.#rules.set(name, {
      name,
      condition: {
        async evaluate(before, after) {
          const was = new Set(
            (await automation.evaluate(before.sql, before.at)).map(
              ({ key }) => key,
            ),
          );
          return (await automation.evaluate(after.sql, after.at))
            .filter(({ key }) => !was.has(key))
            .map(
              (match) => (signal: AbortSignal) => automation.act(match, signal),
            );
        },
      },
    });
  }

  // Evaluates each automation from its cursor and acts on each new match. A
  // new automation starts from now, so its first run tells nothing. An
  // automation that fails, in its condition or its action, is told on stderr
  // and counted; the others still act. A cursor the warehouse no longer
  // reads starts again from now, and is counted too, so a gap is never
  // silent. Each cursor is saved after its actions, so a run that stops
  // between them acts again rather than not at all. Resolves to the number
  // of failures.
  async run(signal: AbortSignal): Promise<number> {
    await this.#cursors`CREATE SCHEMA IF NOT EXISTS proactive`;
    await this
      .#cursors`CREATE TABLE IF NOT EXISTS proactive.cursors (automation text PRIMARY KEY, cursor text NOT NULL)`;
    const saved = new Map(
      (
        await this.#cursors<
          { automation: string; cursor: string }[]
        >`SELECT automation, cursor FROM proactive.cursors`
      ).map(({ automation, cursor }) => [automation, cursor]),
    );
    const rules: { rule: Named; cursor: string }[] = [];
    for (const rule of this.#rules.values()) {
      const cursor = saved.get(rule.name);
      if (cursor === undefined)
        await this.#save(rule.name, await this.#eca.start());
      else rules.push({ rule, cursor });
    }
    let failures = 0;
    for await (const outcome of this.#eca.evaluate(rules)) {
      if (signal.aborted) break;
      const { name } = outcome.rule;
      if ('expired' in outcome) {
        failures += 1;
        process.stderr.write(
          `The automation ${name} starts again from now: ${outcome.expired}\n`,
        );
        await this.#save(name, await this.#eca.start());
        continue;
      }
      if ('error' in outcome) {
        failures += 1;
        process.stderr.write(
          `An automation failed: ${String(outcome.error)}\n`,
        );
      }
      for (const act of outcome.matches)
        try {
          const receipt = await act(signal);
          await promisify(execFile)(this.#osascript, [
            '-e',
            'on run argv',
            '-e',
            'display notification (item 1 of argv) with title "Proactive"',
            '-e',
            'end run',
            receipt,
          ]);
        } catch (error) {
          failures += 1;
          process.stderr.write(`An automation failed: ${String(error)}\n`);
        }
      await this.#save(name, outcome.cursor);
    }
    return failures;
  }

  async #save(name: string, cursor: string): Promise<void> {
    await this.#cursors`
      INSERT INTO proactive.cursors (automation, cursor) VALUES (${name}, ${cursor})
      ON CONFLICT (automation) DO UPDATE SET cursor = excluded.cursor`;
  }
}
