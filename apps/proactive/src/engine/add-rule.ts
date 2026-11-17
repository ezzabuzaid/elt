import type postgres from 'postgres';
import { parse } from 'yaml';
import { z } from 'zod';

import type { Reading } from '@eltjs/eca';

import type { RuleStore, StoredRule } from './rule-store.ts';
import { fill } from './sql-rule.ts';

const words = {
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'a kebab-case name'),
  when: z.string().min(1),
  sql: z.string().min(1),
};

// A rule as a user or an agent writes it, in YAML or JSON: its name, its
// words, its SQL, and exactly one action.
const RuleDocument = z.union([
  z.strictObject({ ...words, notify: z.string().min(1) }),
  z.strictObject({ ...words, agent: z.string().min(1) }),
]);

// Checks a rule against the warehouse as the reading holds it, and keeps it.
// The check runs the rule's SQL in the reading, which is read-only: a rule
// whose SQL fails, or whose message names a column that the SQL does not
// select, is not kept, also when no row is true now. Resolves to what the
// rule finds true now, one line for each row, which the rule does not tell:
// a new rule tells only what becomes true after its first run.
export async function addRule(
  document: string,
  reading: Reading<postgres.Sql>,
  store: RuleStore,
): Promise<string[]> {
  const rule: StoredRule = RuleDocument.parse(parse(document));
  const rows = await reading.sql.unsafe(rule.sql);
  const lines =
    rule.notify === undefined
      ? rows.map((row) => JSON.stringify(row))
      : notify(rule.notify, rows);
  store.add(rule);
  return lines;
}

// The message of each row. A row of every selected column checks the
// message's columns when no row is true.
function notify(message: string, rows: postgres.RowList<postgres.Row[]>) {
  fill(
    message,
    Object.fromEntries(rows.columns.map(({ name }) => [name, null])),
  );
  return rows.map((row) => fill(message, row));
}
