// Foundation and Core Data store a date as seconds since 2001-01-01 UTC in a
// double, which resolves about a tenth of a microsecond today, so it is
// written to the microsecond.
export function referenceDateInstant(seconds: number): string {
  const micros = Math.round(seconds * 1e6);
  const whole = Math.floor(micros / 1e6);
  const iso = new Date((whole + 978307200) * 1000).toISOString();
  return `${iso.slice(0, 19)}.${String(micros - whole * 1e6).padStart(6, '0')}Z`;
}
