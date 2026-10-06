import type { RecordDraft } from '@workspace/elt';
import type { Theme } from '@workspace/sdk-apple-books';

import type { BooksScan } from '../books-scan.ts';
import { BooksStream, booksFields } from '../books-stream.ts';

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

export class ThemesStream extends BooksStream<typeof properties, Theme> {
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

  protected rows(scan: BooksScan): readonly Theme[] {
    return scan.themes.themes();
  }

  protected record(theme: Theme): RecordDraft<typeof properties> {
    return {
      id: theme.id,
      hasCustomLayout: theme.hasCustomLayout,
      boldText: theme.boldText,
      justify: theme.justify,
      multipleColumns: theme.multipleColumns,
      letterSpacing: theme.letterSpacing,
      lineHeight: theme.lineHeight,
      marginAdjustment: theme.marginAdjustment,
      wordSpacing: theme.wordSpacing,
    };
  }
}
