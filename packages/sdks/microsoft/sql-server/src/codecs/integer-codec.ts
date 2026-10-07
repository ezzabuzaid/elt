import { SqlServerCodec } from './sql-server-codec.ts';

// tinyint, smallint and int, which a JavaScript number holds exactly.
export class IntegerCodec extends SqlServerCodec<number> {
  readonly value = { kind: 'integer' } as const;
  readonly #type: string;

  constructor(type: string) {
    super();
    this.#type = type;
  }

  select(reference: string): readonly string[] {
    return [reference];
  }

  decode([value]: readonly unknown[]): number | null {
    if (value === null) return null;
    if (!Number.isSafeInteger(value))
      throw new TypeError(
        `SQL Server returned ${String(value)} for ${this.#type}`,
      );
    return Number(value);
  }

  override cast(parameter: string): string {
    return `CAST(${parameter} AS ${this.#type})`;
  }
}
