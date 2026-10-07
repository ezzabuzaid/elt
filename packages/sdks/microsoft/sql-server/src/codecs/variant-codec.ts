import { VariantValue } from '../values.ts';
import { SqlServerCodec, text } from './sql-server-codec.ts';

// sql_variant: the value as text, by the style that keeps its base type
// exact (126 for times, 3 for floating point, 1 for bytes in hex), and the
// base type itself.
export class VariantCodec extends SqlServerCodec<VariantValue> {
  readonly value = { kind: 'variant' } as const;

  select(reference: string): readonly string[] {
    const type = `SQL_VARIANT_PROPERTY(${reference}, 'BaseType')`;
    return [
      `CASE WHEN ${type} IN ('binary', 'varbinary') THEN CONVERT(nvarchar(max), CAST(${reference} AS varbinary(8000)), 1) WHEN ${type} IN ('float', 'real') THEN CONVERT(nvarchar(max), CAST(${reference} AS float), 3) ELSE CONVERT(nvarchar(max), ${reference}, 126) END`,
      `CONVERT(varchar(128), ${type})`,
    ];
  }

  decode([value, type]: readonly unknown[]): VariantValue | null {
    return value === null
      ? null
      : new VariantValue(text(value, 'sql_variant'), text(type, 'sql_variant'));
  }
}
