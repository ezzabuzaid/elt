import { FieldFormat } from './field-format.ts';

const min = -(2n ** 63n);
const max = 2n ** 63n - 1n;

// format: 'int64': a signed 64-bit integer as decimal text without leading
// zeros, so a value past Number.MAX_SAFE_INTEGER keeps every digit through
// JSON. Its text does not sort as its value, so cursors compare the integers.
export class Int64Format extends FieldFormat {
  readonly name = 'int64';
  override readonly ordering = 'as 64-bit integers';

  accepts(value: string): boolean {
    if (!/^-?(0|[1-9]\d*)$/.test(value) || value === '-0') return false;
    const integer = BigInt(value);
    return integer >= min && integer <= max;
  }

  override compare(left: string, right: string): number {
    const a = BigInt(left);
    const b = BigInt(right);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
}
