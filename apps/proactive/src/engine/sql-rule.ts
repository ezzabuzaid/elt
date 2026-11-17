import type postgres from 'postgres';

import type { Reading } from '@eltjs/eca';

import { AgentAutomation } from './agent-automation.ts';
import { NotifyAutomation } from './notify-automation.ts';

// One row that a stored rule's SQL gives, by its column names.
export type Row = Readonly<Record<string, unknown>>;

// A stored rule's condition: the rows that its SQL gives as of after and did
// not give as of before. Rows are compared whole, so a rule chooses what it
// compares by the columns it selects; a row that changes while it stays
// true, such as a running total, is a new row. A row given twice matches once.
async function appeared(
  query: string,
  before: Reading<postgres.Sql>,
  after: Reading<postgres.Sql>,
): Promise<Row[]> {
  const seen = new Set(
    (await before.sql.unsafe(query)).map((row) => JSON.stringify(row)),
  );
  return (await after.sql.unsafe(query)).filter((row: Row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// A stored rule's message for one row: each {column} is the row's value.
export function fill(message: string, row: Row): string {
  return message.replaceAll(/\{(\w+)\}/gu, (_, column: string) => {
    if (!Object.hasOwn(row, column))
      throw new TypeError(
        `The message names {${column}}, which the rule's SQL does not select`,
      );
    return String(row[column]);
  });
}

// A stored rule that tells the user: its message names columns as {column}.
export class SqlNotifyRule extends NotifyAutomation<Row> {
  readonly #query: string;
  readonly #message: string;

  constructor(query: string, message: string) {
    super();
    this.#query = query;
    this.#message = message;
  }

  message(match: Row): string {
    return fill(this.#message, match);
  }

  evaluate(before: Reading<postgres.Sql>, after: Reading<postgres.Sql>) {
    return appeared(this.#query, before, after);
  }
}

// A stored rule whose action is an instruction to an agent, which gets the
// matched row with it.
export class SqlAgentRule extends AgentAutomation<Row> {
  readonly instruction: string;
  readonly #query: string;

  constructor(
    query: string,
    instruction: string,
    directory: string,
    codex?: string,
  ) {
    super(directory, codex);
    this.#query = query;
    this.instruction = instruction;
  }

  evaluate(before: Reading<postgres.Sql>, after: Reading<postgres.Sql>) {
    return appeared(this.#query, before, after);
  }
}
