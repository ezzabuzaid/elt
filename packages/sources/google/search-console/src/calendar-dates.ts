import { isCalendarDate } from '@workspace/elt';

export function addDays(date: string, days: number): string {
  return calendarDate(date).add({ days }).toString();
}

/**
 * Calendar months, clamped to the end of a shorter month: sixteen months
 * before 31 March is 30 November, and an unclamped subtraction would roll
 * into December and drop a month of history. Counting fixed-length days
 * drifts for the same reason.
 */
export function subMonths(date: string, months: number): string {
  return calendarDate(date).subtract({ months }).toString();
}

// Temporal also reads a date with a time; Google's dates carry none.
function calendarDate(date: string): Temporal.PlainDate {
  if (!isCalendarDate(date)) throw new TypeError(`Invalid date: ${date}`);
  return Temporal.PlainDate.from(date);
}

export function earlier(left: string, right: string): string {
  return left < right ? left : right;
}
