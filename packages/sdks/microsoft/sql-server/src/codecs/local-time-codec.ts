import { SqlServerCodec, text } from './sql-server-codec.ts';

// time: a time of day, which the default style spells with exactly its
// precision's fraction digits, zeros included.
export class LocalTimeCodec extends SqlServerCodec<string> {
  readonly value: { readonly kind: 'local-time'; readonly precision: number };
  readonly #declared: string;

  constructor(declared: string, precision: number) {
    super();
    this.value = { kind: 'local-time', precision };
    this.#declared = declared;
  }

  select(reference: string): readonly string[] {
    return [`CONVERT(varchar(16), ${reference})`];
  }

  decode([value]: readonly unknown[]): string | null {
    return value === null ? null : text(value, this.#declared);
  }

  override cast(parameter: string): string {
    return `CAST(${parameter} AS ${this.#declared})`;
  }
}
