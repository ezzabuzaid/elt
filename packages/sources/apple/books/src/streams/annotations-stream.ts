import type { RecordDraft } from '@workspace/elt';
import { type Annotation, annotationKinds } from '@workspace/sdk-apple-books';

import type { BooksScan } from '../books-scan.ts';
import { BooksStream, booksFields, iso } from '../books-stream.ts';

const { boolean, nullableInteger, nullableText, nullableTimestamp } =
  booksFields;

const properties = {
  id: { ...booksFields.id, description: 'Annotation UUID.' },
  assetId: {
    ...booksFields.nullableId,
    description:
      'The annotated book; refers to libraryAssets.assetId, or to a book no longer in the library. NULL on deletion markers, which Books keeps without the book.',
  },
  kind: {
    ...nullableText,
    enum: annotationKinds,
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
      'Highlight style: 0 underline (underline is true), 1 green, 2 blue, 3 yellow, 4 pink, 5 purple.',
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

export class AnnotationsStream extends BooksStream<
  typeof properties,
  Annotation
> {
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

  protected rows(scan: BooksScan): readonly Annotation[] {
    return scan.annotations.annotations();
  }

  protected record(annotation: Annotation): RecordDraft<typeof properties> {
    return {
      id: annotation.id,
      assetId: annotation.assetId,
      kind: annotation.kind,
      kindCode: annotation.kindCode,
      style: annotation.style,
      underline: annotation.underline,
      deleted: annotation.deleted,
      selectedText: annotation.selectedText,
      representativeText: annotation.representativeText,
      note: annotation.note,
      chapter: annotation.chapter,
      location: annotation.location,
      rangeStart: annotation.rangeStart,
      rangeEnd: annotation.rangeEnd,
      physicalLocation: annotation.physicalLocation,
      storageId: annotation.storageId,
      creator: annotation.creator,
      createdAt: iso(annotation.createdAt),
      modifiedAt: iso(annotation.modifiedAt),
    };
  }
}
