import { SqlServerCodec, text } from './sql-server-codec.ts';

// Character types, and the types SQL Server spells as text: uniqueidentifier,
// xml, hierarchyid and json.
export class TextCodec extends SqlServerCodec<string> {
  readonly value = { kind: 'text' } as const;
  readonly #type: string;
  readonly #read: (reference: string) => string;
  readonly #cast?: (parameter: string) => string;

  constructor(
    type: string,
    read: (reference: string) => string,
    cast?: (parameter: string) => string,
  ) {
    super();
    this.#type = type;
    this.#read = read;
    this.#cast = cast;
  }

  select(reference: string): readonly string[] {
    return [this.#read(reference)];
  }

  decode([value]: readonly unknown[]): string | null {
    return value === null ? null : text(value, this.#type);
  }

  override cast(parameter: string): string | undefined {
    return this.#cast?.(parameter);
  }
}
