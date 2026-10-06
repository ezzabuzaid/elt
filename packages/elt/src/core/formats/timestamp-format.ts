import { TemporalFormat } from './temporal-format.ts';

// format: 'date-time': a UTC instant ending in Z.
export class TimestampFormat extends TemporalFormat {
  readonly name = 'date-time';
  readonly #pattern = new RegExp(
    `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}${this.fraction}Z$`,
  );

  accepts(value: string): boolean {
    return this.#pattern.test(value) && this.real(value.slice(0, 19));
  }
}

const milliseconds = new TimestampFormat();

// A UTC timestamp exactly as Date#toISOString writes it.
export function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && milliseconds.accepts(value);
}
