import type { SchemaRecord } from 'elt';
import type { BooksScan } from '../books-scan.ts';
import { BooksStream, booksFields } from '../books-stream.ts';
import {
  coreDataTime,
  flag,
  integer,
  type Row,
  text,
} from '../books-values.ts';

const { boolean, nullableInteger, nullableText, nullableTimestamp } =
  booksFields;

// Codes verified against a live store; others keep their code alone.
const kinds: Readonly<Record<number, string>> = {
  2: 'highlight',
  3: 'readingPosition',
};

const properties = {
  id: { ...booksFields.id, description: 'Annotation UUID.' },
  assetId: {
    ...booksFields.nullableId,
    description:
      'The annotated book; refers to libraryAssets.assetId, or to a book no longer in the library. NULL on deletion markers, which Books keeps without the book.',
  },
  kind: {
    ...nullableText,
    enum: Object.values(kinds),
    description:
      'highlight: highlighted or underlined text, with an optional note; readingPosition: where Books last left the book. NULL for any other kind, whose code is in kindCode.',
  },
  kindCode: {
    ...nullableInteger,
    description: 'Books annotation type code.',
  },
  style: {
    ...nullableInteger,
    description:
      'Highlight style code: 0 is the underline style (underline is true); 1 to 5 are the highlight colours.',
  },
  underline: {
    ...boolean,
    description: 'Shown as an underline rather than a highlight.',
  },
  deleted: {
    ...boolean,
    description:
      'Deleted in Books and kept as a marker until the deletion syncs; such rows carry no text or location.',
  },
  selectedText: {
    ...nullableText,
    description: 'The highlighted text.',
  },
  representativeText: {
    ...nullableText,
    description: 'Surrounding text Books stored for context.',
  },
  note: { ...nullableText, description: 'Note the user attached.' },
  chapter: {
    ...nullableText,
    description: 'Chapter title at the annotation, as Books stored it.',
  },
  location: {
    ...nullableText,
    description: 'Position in the book as an EPUB CFI (epubcfi(...)).',
  },
  rangeStart: {
    ...nullableInteger,
    description: 'Start offset of the position within its chapter.',
  },
  rangeEnd: {
    ...nullableInteger,
    description: 'End offset of the position within its chapter.',
  },
  physicalLocation: {
    ...nullableInteger,
    description:
      'Absolute position in the book, for fixed-layout and PDF books.',
  },
  storageId: {
    ...nullableText,
    description: 'Books storage identifier of the chapter.',
  },
  creator: {
    ...nullableText,
    description: 'App that made the annotation, such as com~apple~iBooks.',
  },
  createdAt: { ...nullableTimestamp, description: 'When it was made.' },
  modifiedAt: {
    ...nullableTimestamp,
    description: 'When it last changed.',
  },
} as const;

export class AnnotationsStream extends BooksStream<typeof properties, Row> {
  readonly name = 'annotations';
  readonly store = 'annotations';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per Books annotation: highlights, underlines and notes, and the reading position Books keeps per book, including deletion markers not yet synced. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: BooksScan): readonly Row[] {
    return scan.annotations.all(
      'SELECT * FROM ZAEANNOTATION WHERE ZANNOTATIONUUID IS NOT NULL ORDER BY Z_PK',
    );
  }

  protected record(row: Row): SchemaRecord<typeof properties> {
    const kindCode = integer(row.ZANNOTATIONTYPE);
    return {
      id: row.ZANNOTATIONUUID as string,
      assetId: text(row.ZANNOTATIONASSETID),
      kind: kindCode === null ? null : (kinds[kindCode] ?? null),
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
  }
}
