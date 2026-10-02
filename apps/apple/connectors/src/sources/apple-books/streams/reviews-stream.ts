import type { RecordDraft } from '@workspace/elt';

import type { BooksScan } from '../books-scan.ts';
import { BooksStream, booksFields } from '../books-stream.ts';
import {
  type Row,
  coreDataTime,
  flag,
  integer,
  text,
} from '../books-values.ts';

const { nullableInteger, nullableText, nullableTimestamp } = booksFields;

const properties = {
  id: { ...booksFields.id, description: 'Review identifier.' },
  deleted: {
    ...booksFields.boolean,
    description: 'Deleted, kept until the deletion syncs.',
  },
  starRating: { ...nullableInteger, description: 'Stars given.' },
  title: { ...nullableText, description: 'Review title.' },
  body: { ...nullableText, description: 'Review text.' },
  userId: {
    ...nullableText,
    description: 'Store user that wrote the review.',
  },
  modifiedAt: {
    ...nullableTimestamp,
    description: 'When the review last changed.',
  },
} as const;

export class ReviewsStream extends BooksStream<typeof properties, Row> {
  readonly name = 'reviews';
  readonly store = 'assetData';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per store review the user wrote in Books, as Books syncs it. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: BooksScan): readonly Row[] {
    return scan.assetData.all(
      'SELECT * FROM ZBCASSETREVIEW WHERE ZASSETREVIEWID IS NOT NULL ORDER BY Z_PK',
    );
  }

  protected record(row: Row): RecordDraft<typeof properties> {
    return {
      id: row.ZASSETREVIEWID,
      deleted: flag(row.ZDELETEDFLAG),
      starRating: integer(row.ZSTARRATING),
      title: text(row.ZREVIEWTITLE),
      body: text(row.ZREVIEWBODY),
      userId: text(row.ZUSERID),
      modifiedAt: coreDataTime(row.ZMODIFICATIONDATE),
    };
  }
}
