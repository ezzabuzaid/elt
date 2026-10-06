import type { ScalarSchema } from '../record-validation.ts';
import { Base64Format } from './base64-format.ts';
import { CalendarDateFormat } from './calendar-date-format.ts';
import { DecimalFormat } from './decimal-format.ts';
import { Int64Format } from './int64-format.ts';
import { LocalTimeFormat } from './local-time-format.ts';
import { LocalTimestampFormat } from './local-timestamp-format.ts';
import { TimestampFormat } from './timestamp-format.ts';

export type DeclaredFormat =
  | TimestampFormat
  | LocalTimestampFormat
  | LocalTimeFormat
  | CalendarDateFormat
  | Int64Format
  | DecimalFormat
  | Base64Format;

// The format a field or array item declares, with the keywords that refine
// it; null for one that declares none. Every format spells a string.
export function declaredFormat(
  schema: ScalarSchema & { readonly type: string | readonly string[] },
): DeclaredFormat | null {
  const { format, precision, scale, contentEncoding } = schema;
  if (format === undefined && contentEncoding === undefined) {
    if (precision !== undefined || scale !== undefined)
      throw new TypeError('precision and scale refine a format');
    return null;
  }
  const types = typeof schema.type === 'string' ? [schema.type] : schema.type;
  if (types.filter((type) => type !== 'null').join() !== 'string')
    throw new TypeError(
      `${format ?? `contentEncoding ${contentEncoding}`} spells a string`,
    );
  if (contentEncoding !== undefined) {
    if (
      contentEncoding !== 'base64' ||
      format !== undefined ||
      precision !== undefined ||
      scale !== undefined
    )
      throw new TypeError('contentEncoding is base64 alone');
    return new Base64Format();
  }
  if (scale !== undefined && format !== 'decimal')
    throw new TypeError('scale refines a decimal');
  if (precision !== undefined && (format === 'date' || format === 'int64'))
    throw new TypeError(`format ${format} has no precision`);
  switch (format) {
    case 'date-time':
      return new TimestampFormat(precision);
    case 'date-time-local':
      return new LocalTimestampFormat(precision);
    case 'time-local':
      return new LocalTimeFormat(precision);
    case 'date':
      return new CalendarDateFormat();
    case 'int64':
      return new Int64Format();
    case 'decimal':
      return new DecimalFormat(precision, scale);
    default:
      throw new TypeError(`Unsupported format ${String(format)}`);
  }
}
