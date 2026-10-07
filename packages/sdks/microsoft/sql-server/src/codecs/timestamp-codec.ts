import { OffsetTimestamp } from '../values.ts';
import { withFraction } from './fraction.ts';
import { SqlServerCodec, text } from './sql-server-codec.ts';

// datetimeoffset: its UTC instant to the column's precision, and the offset
// it was written with, in minutes. The driver keeps neither the seventh
// digit nor the offset.
export class TimestampCodec extends SqlServerCodec<OffsetTimestamp> {
  readonly value: { readonly kind: 'timestamp'; readonly precision: number };
  readonly #declared: string;

  constructor(declared: string, precision: number) {
    super();
    this.value = { kind: 'timestamp', precision };
    this.#declared = declared;
  }

  select(reference: string): readonly string[] {
    return [
      `CONVERT(varchar(27), CAST(SWITCHOFFSET(${reference}, 0) AS datetime2(${this.value.precision})), 126)`,
      `DATEPART(TZOFFSET, ${reference})`,
    ];
  }

  decode([instant, offset]: readonly unknown[]): OffsetTimestamp | null {
    if (instant === null) return null;
    if (!Number.isSafeInteger(offset))
      throw new TypeError(`SQL Server returned offset ${String(offset)}`);
    return new OffsetTimestamp(
      `${withFraction(text(instant, this.#declared), this.value.precision)}Z`,
      Number(offset),
    );
  }

  // datetimeoffset values compare by their instant, whatever their offset.
  override cast(parameter: string): string {
    return `CONVERT(${this.#declared}, ${parameter}, 127)`;
  }

  override position(value: OffsetTimestamp): string {
    return value.instant;
  }
}
