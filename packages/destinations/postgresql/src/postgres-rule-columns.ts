import { Vector } from '@zukhruf/vectors';
import { toSql } from '@zukhruf/vectors/sqlite';

import type { RuleColumn, RuleColumns, RuleValues } from '@eltjs/elt';

// The Postgres type of each kind of rule column: a vector is the bytes of
// @zukhruf/vectors/sqlite, float32 values little-endian.
export const ruleColumnTypes: Readonly<Record<RuleColumn['type'], string>> = {
  text: 'text',
  blob: 'bytea',
  vector: 'bytea',
  integer: 'bigint',
};

// The value of a rule column as the driver sends it: bytes as bytea, and a
// column with no value as NULL.
export function ruleValue(
  value: RuleValues<RuleColumns>[string],
): string | number | Buffer | null {
  if (value instanceof Vector) return Buffer.from(toSql(value));
  if (value instanceof Uint8Array) return Buffer.from(value);
  return value ?? null;
}
