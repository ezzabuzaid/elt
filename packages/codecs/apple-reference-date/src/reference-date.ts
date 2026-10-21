// Seconds from 1970-01-01 to 2001-01-01 UTC, the reference date.
const referenceDateSeconds = 978_307_200;

// NSDate's distantPast (year 1) and distantFuture (year 4001), in seconds
// since the reference date; Apple's stores write them to mean "none" or
// "unbounded".
const distantPast = -63_114_076_800;
const distantFuture = 63_113_904_000;

// Foundation and Core Data store a date as seconds since 2001-01-01 UTC in a
// double, which resolves about a tenth of a microsecond today, so it is
// written to the microsecond.
export function referenceDateInstant(seconds: number): string {
  const micros = Math.round(seconds * 1e6);
  const whole = Math.floor(micros / 1e6);
  const iso = new Date((whole + referenceDateSeconds) * 1000).toISOString();
  return `${iso.slice(0, 19)}.${String(micros - whole * 1e6).padStart(6, '0')}Z`;
}

// The same seconds as a Date, rounded to the millisecond a Date holds.
export function referenceDate(seconds: number): Date {
  return new Date(Math.round((seconds + referenceDateSeconds) * 1000));
}

// Whether the seconds name a real time: strictly between distantPast and
// distantFuture, so neither sentinel, nothing beyond them, and not NaN.
export function isWithinDistantDates(seconds: number): boolean {
  return seconds > distantPast && seconds < distantFuture;
}
