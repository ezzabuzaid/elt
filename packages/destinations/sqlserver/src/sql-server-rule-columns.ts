import { Vector } from '@zukhruf/vectors';
import { sqlType, toSql } from '@zukhruf/vectors/sqlserver';

import type { RuleColumn, RuleColumns, RuleValues } from '@eltjs/elt';

// The most dimensions of a float32 VECTOR that SQL Server holds (ADR 0007).
const mostDimensions = 1998;

// The type of a rule column in the raw table, as sys.columns spells it:
// text NVARCHAR(MAX), bytes VARBINARY(MAX), an integer BIGINT, and a vector
// VECTOR(n) of float32 values. A vector column of more dimensions than SQL
// Server holds is a TypeError.
export function ruleColumnType(name: string, column: RuleColumn): string {
  switch (column.type) {
    case 'text':
      return 'nvarchar(max)';
    case 'blob':
      return 'varbinary(max)';
    case 'integer':
      return 'bigint';
    case 'vector':
      if (column.dimensions > mostDimensions)
        throw new TypeError(
          `The vector column ${name} has ${column.dimensions} dimensions; a float32 VECTOR of SQL Server holds at most ${mostDimensions}`,
        );
      return sqlType(Vector, column.dimensions).toLowerCase();
  }
}

// The type that OPENJSON reads a value of the column as: bytes travel as
// base64 text, which BASE64_DECODE takes only as varchar (ADR 0011).
export function ruleBatchType(column: RuleColumn): string {
  switch (column.type) {
    case 'blob':
      return 'varchar(max)';
    case 'integer':
      return 'bigint';
    case 'text':
    case 'vector':
      return 'nvarchar(max)';
  }
}

// The stored value of what OPENJSON read as alias: base64 text decoded, and
// the JSON text of a vector cast to the type of its column.
export function ruleStored(
  name: string,
  column: RuleColumn,
  alias: string,
): string {
  switch (column.type) {
    case 'blob':
      return `BASE64_DECODE(${alias})`;
    case 'vector':
      return `CAST(${alias} AS ${ruleColumnType(name, column)})`;
    case 'text':
    case 'integer':
      return alias;
  }
}

// The value of a rule column in the form the table stores it, which the row
// hash counts: a vector as the JSON text of @zukhruf/vectors/sqlserver, and
// a column with no value as null.
export function storedValue(
  value: RuleValues<RuleColumns>[string],
): string | number | Uint8Array | null {
  if (value instanceof Vector) return toSql(value);
  return value ?? null;
}

// A stored value as JSON carries it: bytes as base64 text.
export function batchValue(
  value: string | number | Uint8Array | null,
): string | number | null {
  return value instanceof Uint8Array
    ? Buffer.from(value).toString('base64')
    : value;
}
