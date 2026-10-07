import { SqlServerCodec } from './sql-server-codec.ts';

// binary, varbinary and image, and user CLR types read as their bytes, as
// base64. A key pages by its bytes in hex, which style 1 reads back.
export class BytesCodec extends SqlServerCodec<string> {
  readonly value = { kind: 'bytes' } as const;
  readonly #declared: string;
  readonly #clr: boolean;

  constructor(declared: string, clr: boolean) {
    super();
    this.#declared = declared;
    this.#clr = clr;
  }

  select(reference: string): readonly string[] {
    return [this.#clr ? `CAST(${reference} AS varbinary(max))` : reference];
  }

  decode([value]: readonly unknown[]): string | null {
    if (value === null) return null;
    if (!(value instanceof Uint8Array))
      throw new TypeError(
        `SQL Server returned a ${typeof value} for ${this.#declared}`,
      );
    return Buffer.from(value).toString('base64');
  }

  override cast(parameter: string): string | undefined {
    return this.#clr || this.#declared === 'image'
      ? undefined
      : `CONVERT(${this.#declared}, ${parameter}, 1)`;
  }

  override position(value: string): string {
    return `0x${Buffer.from(value, 'base64').toString('hex')}`;
  }
}
