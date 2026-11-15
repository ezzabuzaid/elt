import { type Snapshot } from '@zukhruf/sqlite-snapshot';

import { appDatabase } from './app-database.ts';
import { nullableFlag, number, stored } from './books-values.ts';

// The BookTheme columns this reader reads; opening the store checks them.
const themesColumns = {
  ZBOOKTHEME: [
    'Z_PK',
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

// A reading theme the user customized, identified by its Z_PK: Books keeps
// no index on ZIDENTIFIER. Unset settings stay NULL.
export type Theme = {
  readonly id: number;
  readonly identifier: string | null;
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
      .iterate('SELECT * FROM ZBOOKTHEME ORDER BY Z_PK')
      .map((row) => ({
        id: Number(row.Z_PK),
        identifier: stored(row.ZIDENTIFIER),
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
