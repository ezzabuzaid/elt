import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type postgres from 'postgres';

import { Eca, type Warehouse } from '@workspace/eca';

import type { Automation } from './automation.ts';

type Command = (signal: AbortSignal) => Promise<string>;

// Runs the automations over one warehouse. Each match reaches eca carrying
// its automation's act, bound to the match, so a new match is a command the
// loop runs, and eca stays unaware of actions.
export class Automations {
  readonly #eca: Eca<postgres.Sql, Command>;
  readonly #osascript: string;

  constructor({
    warehouse,
    osascript = '/usr/bin/osascript',
  }: {
    warehouse: Warehouse<postgres.Sql>;
    osascript?: string;
  }) {
    this.#eca = new Eca({ warehouse });
    this.#osascript = osascript;
  }

  async add<Data>(automation: Automation<Data>): Promise<void> {
    await this.#eca.add({
      condition: {
        async evaluate(sql) {
          return (await automation.evaluate(sql)).map((match) => ({
            key: match.key,
            data: (signal: AbortSignal) => automation.act(match, signal),
          }));
        },
      },
    });
  }

  // An automation that fails, in its condition or its action, is told on
  // stderr and counted; the others still act. A condition that threw is
  // evaluated again at the next commit. Resolves to the number of failures.
  async run(signal: AbortSignal): Promise<number> {
    let failures = 0;
    for await (const match of this.#eca.watch({ signal })) {
      if ('error' in match) {
        failures += 1;
        process.stderr.write(`An automation failed: ${String(match.error)}\n`);
        continue;
      }
      try {
        const receipt = await match.data(signal);
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
    }
    return failures;
  }
}
