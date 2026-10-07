import type { SqlServerCodec } from './codecs/sql-server-codec.ts';
import { quoteName } from './quote-name.ts';
import type { SqlServerValue } from './values.ts';

export class SqlServerColumn {
  readonly name: string;
  // The type as the column declares it, such as decimal(19, 4).
  readonly type: string;
  readonly nullable: boolean;
  // Dynamic data masking hides its values from a login without UNMASK.
  readonly masked: boolean;
  // Its MS_Description extended property.
  readonly description: string | null;
  readonly codec: SqlServerCodec<SqlServerValue>;

  constructor(column: {
    name: string;
    type: string;
    nullable: boolean;
    masked: boolean;
    description: string | null;
    codec: SqlServerCodec<SqlServerValue>;
  }) {
    this.name = column.name;
    this.type = column.type;
    this.nullable = column.nullable;
    this.masked = column.masked;
    this.description = column.description;
    this.codec = column.codec;
    Object.freeze(this);
  }

  get quoted(): string {
    return quoteName(this.name);
  }
}
