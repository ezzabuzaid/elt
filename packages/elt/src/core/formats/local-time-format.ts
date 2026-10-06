import { TemporalFormat } from './temporal-format.ts';

// format: 'time-local': a time of day with no zone, as SQL's TIME stores it.
// JSON Schema's own `time` requires an offset, so it cannot carry one.
export class LocalTimeFormat extends TemporalFormat {
  readonly name = 'time-local';
  readonly #pattern = new RegExp(`^\\d{2}:\\d{2}:\\d{2}${this.fraction}$`);

  accepts(value: string): boolean {
    return (
      this.#pattern.test(value) && this.real(`1970-01-01T${value.slice(0, 8)}`)
    );
  }
}
