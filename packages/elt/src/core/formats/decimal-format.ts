import { FieldFormat } from './field-format.ts';

// format: 'decimal': an exact decimal number as text, never through a binary
// float. With a scale, a value has exactly that many fraction digits, as SQL
// writes NUMERIC(p,s) as text; without one, its fraction has no trailing
// zeros. Either way each value has one spelling, so equal keys are equal
// text. Text does not sort as the numbers do, so it cannot be a cursor.
export class DecimalFormat extends FieldFormat {
  readonly name = 'decimal';
  override readonly orderable = false;
  // Most significant digits a value has, before and after the point.
  readonly precision: number | undefined;
  readonly scale: number | undefined;

  constructor(precision?: number, scale?: number) {
    super();
    if (
      precision !== undefined &&
      (!Number.isSafeInteger(precision) || precision < 1)
    )
      throw new TypeError('Decimal precision must be a positive integer');
    if (
      scale !== undefined &&
      (precision === undefined ||
        !Number.isSafeInteger(scale) ||
        scale < 0 ||
        scale > precision)
    )
      throw new TypeError(
        'Decimal scale must be an integer from 0 to its precision',
      );
    this.precision = precision;
    this.scale = scale;
  }

  accepts(value: string): boolean {
    const match = /^-?(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
    if (match === null) return false;
    const [, integer = '', fraction = ''] = match;
    if (value.startsWith('-') && /^0+$/.test(integer + fraction)) return false;
    if (
      this.scale === undefined
        ? fraction.endsWith('0')
        : fraction.length !== this.scale
    )
      return false;
    return (
      this.precision === undefined ||
      (integer === '0' ? 0 : integer.length) + fraction.length <= this.precision
    );
  }
}
