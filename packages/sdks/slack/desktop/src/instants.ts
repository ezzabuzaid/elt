// Slack's counts of seconds or milliseconds as instants; 0 means none.

export function seconds(value: number | null): string | null {
  return value === null || value === 0
    ? null
    : new Date(value * 1000).toISOString();
}

export function milliseconds(value: number | null): string | null {
  return value === null || value === 0 ? null : new Date(value).toISOString();
}
