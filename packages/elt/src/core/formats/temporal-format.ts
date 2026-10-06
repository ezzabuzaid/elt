import { FieldFormat } from './field-format.ts';

// A time spelling whose fraction of a second has exactly `precision` digits,
// none at precision 0, so the values of one field share a width and sort by
// bytes as they do in time. Precision defaults to milliseconds.
export abstract class TemporalFormat extends FieldFormat {
  readonly precision: number;

  constructor(precision = 3) {
    super();
    if (!Number.isInteger(precision) || precision < 0 || precision > 9)
      throw new TypeError(
        'Temporal precision must be an integer from 0 to 9 fraction digits',
      );
    this.precision = precision;
  }

  // The pattern of the seconds' fraction this precision requires.
  protected get fraction(): string {
    return this.precision === 0 ? '' : `\\.\\d{${this.precision}}`;
  }

  // Whether a `YYYY-MM-DDTHH:MM:SS` names a real second of the calendar.
  protected real(second: string): boolean {
    const instant = `${second}.000Z`;
    const time = Date.parse(instant);
    return Number.isFinite(time) && new Date(time).toISOString() === instant;
  }
}
