import type { SqlServerValue } from '../values.ts';

// What a column's values are, for a reader deciding how to describe them.
export type ValueKind =
  | { readonly kind: 'text' }
  | { readonly kind: 'integer' }
  | { readonly kind: 'int64' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'number' }
  | {
      readonly kind: 'decimal';
      readonly precision: number;
      readonly scale: number;
    }
  | { readonly kind: 'date' }
  | { readonly kind: 'local-timestamp'; readonly precision: number }
  | { readonly kind: 'timestamp'; readonly precision: number }
  | { readonly kind: 'local-time'; readonly precision: number }
  | { readonly kind: 'bytes' }
  | { readonly kind: 'spatial' }
  | { readonly kind: 'variant' };

// How a read takes one SQL Server type exactly. The driver hands decimal and
// money over as JavaScript numbers and datetime2 as a millisecond Date, and
// drops a datetimeoffset's offset, so each codec selects text SQL Server
// spells exactly, and decodes it into the value's canonical form.
export abstract class SqlServerCodec<Value extends SqlServerValue> {
  abstract readonly value: ValueKind;

  // The SQL expressions that read the column, given a reference to it.
  abstract select(reference: string): readonly string[];

  // The value from what the driver returned for those expressions.
  abstract decode(values: readonly unknown[]): Value | null;

  // A key column pages through a table: its value as text, and the SQL that
  // turns a parameter holding that text back into the column's type, so a
  // comparison orders as the column sorts. A type that cannot be compared,
  // such as xml, returns undefined.
  cast(_parameter: string): string | undefined {
    return undefined;
  }

  position(value: Value): string {
    return String(value);
  }
}

export function text(value: unknown, type: string): string {
  if (typeof value !== 'string')
    throw new TypeError(`SQL Server returned a ${typeof value} for ${type}`);
  return value;
}
