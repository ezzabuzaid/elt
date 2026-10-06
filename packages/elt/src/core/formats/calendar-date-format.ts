import { FieldFormat } from './field-format.ts';
import { isTimestamp } from './timestamp-format.ts';

// format: 'date': a day of the Gregorian calendar.
export class CalendarDateFormat extends FieldFormat {
  readonly name = 'date';

  accepts(value: string): boolean {
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(value) && isTimestamp(`${value}T00:00:00.000Z`)
    );
  }
}

const day = new CalendarDateFormat();

export function isCalendarDate(value: unknown): value is string {
  return typeof value === 'string' && day.accepts(value);
}
