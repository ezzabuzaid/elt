import { SqlServerCodec, text } from './sql-server-codec.ts';

// decimal and numeric, spelled with exactly their scale's digits, and money
// and smallmoney, spelled with their four by style 2.
export class DecimalCodec extends SqlServerCodec<string> {
  readonly value: {
    readonly kind: 'decimal';
    readonly precision: number;
    readonly scale: number;
  };
  readonly #declared: string;
  readonly #money: boolean;

  constructor(
    declared: string,
    precision: number,
    scale: number,
    money: boolean,
  ) {
    super();
    this.value = { kind: 'decimal', precision, scale };
    this.#declared = declared;
    this.#money = money;
  }

  select(reference: string): readonly string[] {
    return [
      this.#money
        ? `CONVERT(varchar(48), ${reference}, 2)`
        : `CONVERT(varchar(48), ${reference})`,
    ];
  }

  decode([value]: readonly unknown[]): string | null {
    return value === null ? null : text(value, this.#declared);
  }

  override cast(parameter: string): string {
    return `CAST(${parameter} AS ${this.#declared})`;
  }
}
