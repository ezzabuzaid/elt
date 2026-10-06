import type { RecordDraft } from '@workspace/elt';
import type { Review } from '@workspace/sdk-apple-books';

import type { BooksScan } from '../books-scan.ts';
import { BooksStream, booksFields, iso } from '../books-stream.ts';

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

export class ReviewsStream extends BooksStream<typeof properties, Review> {
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

  protected rows(scan: BooksScan): readonly Review[] {
    return scan.assetData.reviews();
  }

  protected record(review: Review): RecordDraft<typeof properties> {
    return {
      id: review.id,
      deleted: review.deleted,
      starRating: review.starRating,
      title: review.title,
      body: review.body,
      userId: review.userId,
      modifiedAt: iso(review.modifiedAt),
    };
  }
}
