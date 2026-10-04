import type { RecordDraft } from '@workspace/elt';

import type { BooksScan } from '../books-scan.ts';
import { BooksStream, booksFields } from '../books-stream.ts';
import { type Row, nullableFlag, number } from '../books-values.ts';

const { nullableBoolean, nullableNumber } = booksFields;

const properties = {
  id: { ...booksFields.id, description: 'Theme identifier.' },
  hasCustomLayout: {
    ...nullableBoolean,
    description: 'Uses custom spacing rather than the theme default.',
  },
  boldText: { ...nullableBoolean, description: 'Bold text.' },
  justify: { ...nullableBoolean, description: 'Justified text.' },
  multipleColumns: {
    ...nullableBoolean,
    description: 'Shows more than one column.',
  },
  letterSpacing: { ...nullableNumber, description: 'Letter spacing.' },
  lineHeight: { ...nullableNumber, description: 'Line height.' },
  marginAdjustment: {
    ...nullableNumber,
    description: 'Margin adjustment.',
  },
  wordSpacing: { ...nullableNumber, description: 'Word spacing.' },
} as const;

export class ThemesStream extends BooksStream<typeof properties, Row> {
  readonly name = 'themes';
  readonly store = 'themes';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per reading theme the user customized in Books (BookTheme). Per-language fonts are left out. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: BooksScan): readonly Row[] {
    return scan.themes.all(
      'SELECT * FROM ZBOOKTHEME WHERE ZIDENTIFIER IS NOT NULL ORDER BY Z_PK',
    );
  }

  protected record(row: Row): RecordDraft<typeof properties> {
    return {
      id: row.ZIDENTIFIER,
      hasCustomLayout: nullableFlag(row.ZHASCUSTOMLAYOUT),
      boldText: nullableFlag(row.ZISFONTBOLDED),
      justify: nullableFlag(row.ZJUSTIFY),
      multipleColumns: nullableFlag(row.ZMULTIPLECOLUMNMODE),
      letterSpacing: number(row.ZLETTERSPACING),
      lineHeight: number(row.ZLINEHEIGHT),
      marginAdjustment: number(row.ZMARGINADJUSTMENT),
      wordSpacing: number(row.ZWORDSPACING),
    };
  }
}
