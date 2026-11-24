import { Vector } from '@zukhruf/vectors';
import { toSql } from 'pgvector';

import type { RuleColumn, RuleColumns, RuleValues } from '@eltjs/elt';

// The Postgres type of a rule column: a vector is the vector type of
// pgvector, with the dimensions of its column.
export function ruleColumnType(column: RuleColumn): string {
  switch (column.type) {
    case 'text':
      return 'text';
    case 'blob':
      return 'bytea';
    case 'vector':
      return `vector(${column.dimensions})`;
    case 'integer':
      return 'bigint';
  }
}

// The value of a rule column as the driver sends it: bytes as bytea, a
// vector as the text of toSql of the npm package pgvector (@zukhruf/vectors
// ADR 0001), and a column with no value as NULL. The text has each float32
// value in full, so pgvector reads it back exactly.
export function ruleValue(
  value: RuleValues<RuleColumns>[string],
): string | number | Buffer | null {
  if (value instanceof Vector) return toSql(Array.from(value.values));
  if (value instanceof Uint8Array) return Buffer.from(value);
  return value ?? null;
}
