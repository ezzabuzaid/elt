// Style 126 and 127 leave a zero fraction of a second out entirely and keep
// every digit of any other, so only a missing fraction needs padding.
export function withFraction(value: string, precision: number): string {
  return precision === 0 || value.includes('.')
    ? value
    : `${value}.${'0'.repeat(precision)}`;
}
