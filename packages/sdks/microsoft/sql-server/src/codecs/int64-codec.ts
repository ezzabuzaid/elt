import { SqlServerCodec, text } from './sql-server-codec.ts';

// bigint, and rowversion read as the bigint it orders as. The driver would
// hand bigint over as a string already, but a rowversion as 8 bytes.
export class Int64Codec extends SqlServerCodec<string> {
  readonly value = { kind: 'int64' } as const;
  readonly #rowversion: boolean;

  constructor(rowversion: boolean) {
    super();
    this.#rowversion = rowversion;
  }

  select(reference: string): readonly string[] {
    return [
      this.#rowversion
        ? `CONVERT(varchar(20), CAST(${reference} AS bigint))`
        : `CONVERT(varchar(20), ${reference})`,
    ];
  }

  decode([value]: readonly unknown[]): string | null {
    return value === null ? null : text(value, 'bigint');
  }

  override cast(parameter: string): string {
    return this.#rowversion
      ? `CAST(CAST(${parameter} AS bigint) AS binary(8))`
      : `CAST(${parameter} AS bigint)`;
  }
}
