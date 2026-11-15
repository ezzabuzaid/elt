import type { RecordDraft } from '@eltjs/elt';
import type { CollectionMember } from '@eltjs/sdk-apple-books';

import type { BooksScan } from '../books-scan.ts';
import { BooksStream, booksFields, iso } from '../books-stream.ts';

const properties = {
  id: {
    ...booksFields.rowId,
    description:
      'The member row; Books can keep one asset in one collection on two rows.',
  },
  collectionId: {
    ...booksFields.nullableRowId,
    description: 'The collection; refers to collections.id.',
  },
  libraryAssetId: {
    ...booksFields.nullableRowId,
    description:
      'The member; refers to libraryAssets.id. NULL when the asset is no longer in the library.',
  },
  assetId: {
    ...booksFields.assetId,
    description:
      'Identifier of the member asset; matches libraryAssets.assetId, and stays after the asset leaves the library.',
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
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per book in a Books collection. Membership names the asset by its identifier, so it outlives the asset leaving the library. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: BooksScan): Iterable<CollectionMember> {
    return scan.library.collectionMembers();
  }

  protected record(member: CollectionMember): RecordDraft<typeof properties> {
    return {
      id: member.id,
      collectionId: member.collectionId,
      libraryAssetId: member.libraryAssetId,
      assetId: member.assetId,
      sortKey: member.sortKey,
      addedAt: iso(member.addedAt),
    };
  }
}
