import { AppDatabase } from '@workspace/sdk-apple-app-database';

import { coreDataTime, flag, integer, stored, text } from './books-values.ts';
import { BooksSchemaError, BooksUnavailableError } from './errors.ts';

// The AEAnnotation columns this reader reads; opening the store checks them.
const annotationsColumns = {
  ZAEANNOTATION: [
    'ZANNOTATIONUUID',
    'ZANNOTATIONASSETID',
    'ZANNOTATIONTYPE',
    'ZANNOTATIONSTYLE',
    'ZANNOTATIONISUNDERLINE',
    'ZANNOTATIONDELETED',
    'ZANNOTATIONSELECTEDTEXT',
    'ZANNOTATIONREPRESENTATIVETEXT',
    'ZANNOTATIONNOTE',
    'ZANNOTATIONLOCATION',
    'ZPLLOCATIONRANGESTART',
    'ZPLLOCATIONRANGEEND',
    'ZPLABSOLUTEPHYSICALLOCATION',
    'ZPLSTORAGEUUID',
    'ZANNOTATIONCREATORIDENTIFIER',
    'ZANNOTATIONCREATIONDATE',
    'ZANNOTATIONMODIFICATIONDATE',
    'ZFUTUREPROOFING5',
  ],
} as const;

export const annotationKinds = ['highlight', 'readingPosition'] as const;
export type AnnotationKind = (typeof annotationKinds)[number];

// Codes verified against a live store; others keep their code alone.
const annotationKindsByCode = new Map<number, AnnotationKind>([
  [2, 'highlight'],
  [3, 'readingPosition'],
]);

// A highlight, note or reading position in a book.
export type Annotation = {
  readonly id: string | null;
  // Blank on Books' deletion markers.
  readonly assetId: string | null;
  readonly kind: AnnotationKind | null;
  readonly kindCode: number | null;
  readonly style: number | null;
  readonly underline: boolean;
  readonly deleted: boolean;
  readonly selectedText: string | null;
  readonly representativeText: string | null;
  readonly note: string | null;
  readonly chapter: string | null;
  readonly location: string | null;
  readonly rangeStart: number | null;
  readonly rangeEnd: number | null;
  readonly physicalLocation: number | null;
  readonly storageId: string | null;
  readonly creator: string | null;
  readonly createdAt: Date | null;
  readonly modifiedAt: Date | null;
};

// AEAnnotation as Books last saved it, pinned to one moment.
export class BooksAnnotations implements Disposable {
  readonly #database: AppDatabase;

  constructor(path: string) {
    this.#database = new AppDatabase(path, BooksUnavailableError);
    this.#database.requireColumns(annotationsColumns, BooksSchemaError);
  }

  annotations(): Annotation[] {
    return this.#database
      .all(
        'SELECT * FROM ZAEANNOTATION WHERE ZANNOTATIONUUID IS NOT NULL ORDER BY Z_PK',
      )
      .map((row) => {
        const kindCode = integer(row.ZANNOTATIONTYPE);
        return {
          id: stored(row.ZANNOTATIONUUID),
          assetId: text(row.ZANNOTATIONASSETID),
          kind:
            kindCode === null
              ? null
              : (annotationKindsByCode.get(kindCode) ?? null),
          kindCode,
          style: integer(row.ZANNOTATIONSTYLE),
          underline: flag(row.ZANNOTATIONISUNDERLINE),
          deleted: flag(row.ZANNOTATIONDELETED),
          selectedText: text(row.ZANNOTATIONSELECTEDTEXT),
          representativeText: text(row.ZANNOTATIONREPRESENTATIVETEXT),
          note: text(row.ZANNOTATIONNOTE),
          chapter: text(row.ZFUTUREPROOFING5),
          location: text(row.ZANNOTATIONLOCATION),
          rangeStart: integer(row.ZPLLOCATIONRANGESTART),
          rangeEnd: integer(row.ZPLLOCATIONRANGEEND),
          physicalLocation: integer(row.ZPLABSOLUTEPHYSICALLOCATION),
          storageId: text(row.ZPLSTORAGEUUID),
          creator: text(row.ZANNOTATIONCREATORIDENTIFIER),
          createdAt: coreDataTime(row.ZANNOTATIONCREATIONDATE),
          modifiedAt: coreDataTime(row.ZANNOTATIONMODIFICATIONDATE),
        };
      });
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}
