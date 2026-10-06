import type { RecordDraft } from '@workspace/elt';
import type { CollectionMember } from '@workspace/sdk-apple-books';

import type { BooksScan } from '../books-scan.ts';
import { BooksStream, booksFields, iso } from '../books-stream.ts';

const properties = {
  collectionId: {
    ...booksFields.id,
    description: 'The collection; refers to collections.collectionId.',
  },
  assetId: {
    ...booksFields.assetId,
    description:
      'The member; refers to libraryAssets.assetId, or to an asset no longer in the library.',
  },
  sortKey: {
    ...booksFields.nullableInteger,
    description: 'Position within the collection when sorted manually.',
  },
  addedAt: {
    ...booksFields.nullableTimestamp,
    description: 'When the member was added or last moved on this Mac.',
  },
} as const;

export class CollectionMembersStream extends BooksStream<
  typeof properties,
  CollectionMember
> {
  readonly name = 'collectionMembers';
  readonly store = 'library';
  readonly primaryKey = ['collectionId', 'assetId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per book in a Books collection. Membership names the asset by its identifier, so it outlives the asset leaving the library. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: BooksScan): readonly CollectionMember[] {
    return scan.library.collectionMembers();
  }

  protected record(member: CollectionMember): RecordDraft<typeof properties> {
    return {
      collectionId: member.collectionId,
      assetId: member.assetId,
      sortKey: member.sortKey,
      addedAt: iso(member.addedAt),
    };
  }
}
