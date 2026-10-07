import type { SqlServerValue } from '../values.ts';
import { BooleanCodec } from './boolean-codec.ts';
import { BytesCodec } from './bytes-codec.ts';
import { DateCodec } from './date-codec.ts';
import { DecimalCodec } from './decimal-codec.ts';
import { Int64Codec } from './int64-codec.ts';
import { IntegerCodec } from './integer-codec.ts';
import { LocalTimeCodec } from './local-time-codec.ts';
import { LocalTimestampCodec } from './local-timestamp-codec.ts';
import { NumberCodec } from './number-codec.ts';
import { SpatialCodec } from './spatial-codec.ts';
import type { SqlServerCodec } from './sql-server-codec.ts';
import { TextCodec } from './text-codec.ts';
import { TimestampCodec } from './timestamp-codec.ts';
import { VariantCodec } from './variant-codec.ts';

// A column's type as sys.columns describes it. name is the system type an
// alias type is built on; it is null for a CLR type the login cannot see.
export type ColumnType = {
  readonly name: string | null;
  readonly clr: boolean;
  readonly maxLength: number;
  readonly precision: number;
  readonly scale: number;
  readonly collation: string | null;
};

// The type as a column declares it, with its length, precision or scale.
export function declaredType(type: ColumnType): string {
  const { name, maxLength, precision, scale } = type;
  switch (name) {
    case 'char':
    case 'varchar':
    case 'binary':
    case 'varbinary':
      return `${name}(${maxLength === -1 ? 'max' : maxLength})`;
    case 'nchar':
    case 'nvarchar':
      return `${name}(${maxLength === -1 ? 'max' : maxLength / 2})`;
    case 'decimal':
    case 'numeric':
      return `${name}(${precision}, ${scale})`;
    case 'datetime2':
    case 'datetimeoffset':
    case 'time':
      return `${name}(${scale})`;
    default:
      return name ?? 'clr';
  }
}

const read = (reference: string) => reference;
const asText = (reference: string) => `CONVERT(nvarchar(max), ${reference})`;

export function codecFor(type: ColumnType): SqlServerCodec<SqlServerValue> {
  const declared = declaredType(type);
  switch (type.name) {
    case 'char':
    case 'varchar':
    case 'nchar':
    case 'nvarchar':
      // Collated as the column, so a key compares as the column sorts.
      return new TextCodec(
        declared,
        read,
        (parameter) =>
          `CAST(${parameter} COLLATE ${type.collation} AS ${declared})`,
      );
    case 'text':
    case 'ntext':
      return new TextCodec(declared, read);
    case 'uniqueidentifier':
      return new TextCodec(
        declared,
        read,
        (parameter) => `CAST(${parameter} AS uniqueidentifier)`,
      );
    case 'hierarchyid':
      return new TextCodec(
        declared,
        (reference) => `${reference}.ToString()`,
        (parameter) => `CAST(${parameter} AS hierarchyid)`,
      );
    case 'xml':
    case 'json':
      return new TextCodec(declared, asText);
    case 'tinyint':
    case 'smallint':
    case 'int':
      return new IntegerCodec(declared);
    case 'bigint':
      return new Int64Codec(false);
    case 'timestamp':
      return new Int64Codec(true);
    case 'bit':
      return new BooleanCodec();
    case 'real':
    case 'float':
      return new NumberCodec(declared);
    case 'decimal':
    case 'numeric':
      return new DecimalCodec(declared, type.precision, type.scale, false);
    case 'money':
      return new DecimalCodec(declared, 19, 4, true);
    case 'smallmoney':
      return new DecimalCodec(declared, 10, 4, true);
    case 'date':
      return new DateCodec();
    case 'datetime2':
      return new LocalTimestampCodec(declared, type.scale);
    case 'datetime':
      return new LocalTimestampCodec(declared, 3);
    case 'smalldatetime':
      return new LocalTimestampCodec(declared, 0);
    case 'datetimeoffset':
      return new TimestampCodec(declared, type.scale);
    case 'time':
      return new LocalTimeCodec(declared, type.scale);
    case 'binary':
    case 'varbinary':
    case 'image':
      return new BytesCodec(declared, false);
    case 'geography':
    case 'geometry':
      return new SpatialCodec();
    case 'sql_variant':
      return new VariantCodec();
    default:
      // A CLR type reads as its bytes; any other type SQL Server adds reads
      // as the text it converts to, and fails its read if it has none.
      return type.clr || type.name === null
        ? new BytesCodec(declared, true)
        : new TextCodec(declared, asText);
  }
}
