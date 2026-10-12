// Date inputs hold the user's local days; a selection holds UTC instants with
// an exclusive end, so the last day the user picks is included.

const pad = (value: number) => String(value).padStart(2, '0');

export function dayOf(instant: string): string {
  const date = new Date(instant);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const lastDayBefore = (end: string) =>
  dayOf(new Date(Date.parse(end) - 1).toISOString());

export const startOfDay = (day: string) =>
  new Date(`${day}T00:00:00`).toISOString();

export function endAfterDay(day: string): string {
  const date = new Date(`${day}T00:00:00`);
  date.setDate(date.getDate() + 1);
  return date.toISOString();
}
