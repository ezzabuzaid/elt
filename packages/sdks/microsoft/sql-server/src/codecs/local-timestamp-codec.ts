import { withFraction } from './fraction.ts';
import { SqlServerCodec, text } from './sql-server-codec.ts';

// datetime2, datetime and smalldatetime: a wall-clock time with no zone, to
// its precision's fraction digits, which the driver's millisecond Date would
// round.
export class LocalTimestampCodec extends SqlServerCodec<string> {
  readonly value: {
    readonly kind: 'local-timestamp';
    readonly precision: number;
  };
  readonly #declared: string;

  constructor(declared: string, precision: number) {
    super();
    this.value = { kind: 'local-timestamp', precision };
    this.#declared = declared;
  }

  select(reference: string): readonly string[] {
    return [`CONVERT(varchar(27), ${reference}, 126)`];
  }

  decode([value]: readonly unknown[]): string | null {
    return value === null
      ? null
      : withFraction(text(value, this.#declared), this.value.precision);
  }

  override cast(parameter: string): string {
    return `CONVERT(${this.#declared}, ${parameter}, 126)`;
  }
}
