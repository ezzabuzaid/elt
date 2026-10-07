import { SqlServerCodec } from './sql-server-codec.ts';

// real and float, IEEE values a JavaScript number holds exactly; its shortest
// spelling reads back as the same value.
export class NumberCodec extends SqlServerCodec<number> {
  readonly value = { kind: 'number' } as const;
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
    if (typeof value !== 'number')
      throw new TypeError(
        `SQL Server returned a ${typeof value} for ${this.#type}`,
      );
    return value;
  }

  override cast(parameter: string): string {
    return `CAST(${parameter} AS ${this.#type})`;
  }
}
