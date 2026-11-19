import type { SQLInputValue } from 'node:sqlite';

import { Vector } from '@zukhruf/vectors';
import { toSql } from '@zukhruf/vectors/sqlite';

import type { RuleColumn, RuleColumns, RuleValues } from '@eltjs/elt';

// The SQLite type of each kind of rule column: a vector is the bytes of
// @zukhruf/vectors/sqlite, float32 values little-endian, which sqlite-vec reads.
export const ruleColumnTypes: Readonly<Record<RuleColumn['type'], string>> = {
  text: 'TEXT',
  blob: 'BLOB',
  vector: 'BLOB',
  integer: 'INTEGER',
};

// The value of a rule column as SQLite keeps it; a column with no value is
// NULL.
export function ruleValue(
  value: RuleValues<RuleColumns>[string],
): SQLInputValue {
  return value instanceof Vector ? toSql(value) : (value ?? null);
}
