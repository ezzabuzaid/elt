import { TemporalFormat } from './temporal-format.ts';

// format: 'date-time-local': a wall-clock date and time with no zone, as
// SQL's TIMESTAMP WITHOUT TIME ZONE stores it.
export class LocalTimestampFormat extends TemporalFormat {
  readonly name = 'date-time-local';
  readonly #pattern = new RegExp(
    `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}${this.fraction}$`,
  );

  accepts(value: string): boolean {
    return this.#pattern.test(value) && this.real(value.slice(0, 19));
  }
}
