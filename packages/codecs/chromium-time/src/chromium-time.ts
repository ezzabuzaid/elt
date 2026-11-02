// Chromium stores a time as the microseconds since 1601-01-01 UTC, the epoch
// of a Windows FILETIME, in a 64-bit integer. Its databases and its JSON
// files write 0 for no time.
const epochOffset = 11_644_473_600_000_000n;

// The time as an ISO 8601 instant to the microsecond, as Chromium keeps it;
// null for 0, which is no time.
export function chromiumInstant(micros: bigint): string | null {
  if (micros === 0n) return null;
  const unix = micros - epochOffset;
  const fraction = ((unix % 1_000_000n) + 1_000_000n) % 1_000_000n;
  const seconds = (unix - fraction) / 1_000_000n;
  const whole = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  return `${whole}.${String(fraction).padStart(6, '0')}Z`;
}

// A Date as Chromium's microseconds since 1601-01-01.
export function chromiumTime(date: Date): bigint {
  return BigInt(date.getTime()) * 1000n + epochOffset;
}
