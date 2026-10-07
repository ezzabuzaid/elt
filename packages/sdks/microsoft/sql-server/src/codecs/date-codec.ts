import { SqlServerCodec, text } from './sql-server-codec.ts';

// The driver would hand a date over as a Date at local midnight; style 23 is
// its ISO calendar date.
export class DateCodec extends SqlServerCodec<string> {
  readonly value = { kind: 'date' } as const;

  select(reference: string): readonly string[] {
    return [`CONVERT(char(10), ${reference}, 23)`];
  }

  decode([value]: readonly unknown[]): string | null {
    return value === null ? null : text(value, 'date');
  }

  override cast(parameter: string): string {
    return `CONVERT(date, ${parameter}, 23)`;
  }
}
