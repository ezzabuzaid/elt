import { type Snapshot } from '@zukhruf/sqlite-snapshot';

import { appDatabase } from './app-database.ts';
import { nullableFlag, number, stored } from './books-values.ts';

// The BookTheme columns this reader reads; opening the store checks them.
const themesColumns = {
  ZBOOKTHEME: [
    'ZIDENTIFIER',
    'ZHASCUSTOMLAYOUT',
    'ZISFONTBOLDED',
    'ZJUSTIFY',
    'ZMULTIPLECOLUMNMODE',
    'ZLETTERSPACING',
    'ZLINEHEIGHT',
    'ZMARGINADJUSTMENT',
    'ZWORDSPACING',
  ],
} as const;

// A reading theme the user customized; unset settings stay NULL.
export type Theme = {
  readonly id: string | null;
  readonly hasCustomLayout: boolean | null;
  readonly boldText: boolean | null;
  readonly justify: boolean | null;
  readonly multipleColumns: boolean | null;
  readonly letterSpacing: number | null;
  readonly lineHeight: number | null;
  readonly marginAdjustment: number | null;
  readonly wordSpacing: number | null;
};

// BookTheme as Books last saved it, pinned to one moment.
export class BooksThemes implements Disposable {
  readonly #database: Snapshot;

  constructor(path: string) {
    this.#database = appDatabase.snapshot(path, themesColumns);
  }

  // Read as the caller iterates, so no read holds the whole table.
  themes(): IteratorObject<Theme, undefined> {
    return this.#database
      .iterate(
        'SELECT * FROM ZBOOKTHEME WHERE ZIDENTIFIER IS NOT NULL ORDER BY Z_PK',
      )
      .map((row) => ({
        id: stored(row.ZIDENTIFIER),
        hasCustomLayout: nullableFlag(row.ZHASCUSTOMLAYOUT),
        boldText: nullableFlag(row.ZISFONTBOLDED),
        justify: nullableFlag(row.ZJUSTIFY),
        multipleColumns: nullableFlag(row.ZMULTIPLECOLUMNMODE),
        letterSpacing: number(row.ZLETTERSPACING),
        lineHeight: number(row.ZLINEHEIGHT),
        marginAdjustment: number(row.ZMARGINADJUSTMENT),
        wordSpacing: number(row.ZWORDSPACING),
      }));
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}
