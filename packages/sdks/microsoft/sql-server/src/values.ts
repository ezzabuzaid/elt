// A datetimeoffset value: its UTC instant, and the offset in minutes it was
// written with, which the instant alone loses.
export class OffsetTimestamp {
  readonly instant: string;
  readonly offset: number;

  constructor(instant: string, offset: number) {
    this.instant = instant;
    this.offset = offset;
    Object.freeze(this);
  }
}

// A sql_variant value: its text, and the base type it holds, which decides
// how to read the text.
export class VariantValue {
  readonly text: string;
  readonly type: string;

  constructor(text: string, type: string) {
    this.text = text;
    this.type = type;
    Object.freeze(this);
  }
}

// One column's value as a read decodes it; null for SQL NULL.
export type SqlServerValue =
  string | number | boolean | OffsetTimestamp | VariantValue | null;
