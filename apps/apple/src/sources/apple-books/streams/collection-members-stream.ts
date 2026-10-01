import type { SchemaRecord } from 'elt';
import type { BooksScan } from '../books-scan.ts';
import { BooksStream, booksFields } from '../books-stream.ts';
import { coreDataTime, integer, type Row } from '../books-values.ts';

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
  Row
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

  protected rows(scan: BooksScan): readonly Row[] {
    return scan.library.all(`
      SELECT collection.ZCOLLECTIONID AS collectionId, member.ZASSETID,
        member.ZSORTKEY, member.ZLOCALMODDATE
      FROM ZBKCOLLECTIONMEMBER member
      JOIN ZBKCOLLECTION collection ON collection.Z_PK = member.ZCOLLECTION
      WHERE collection.ZCOLLECTIONID IS NOT NULL AND member.ZASSETID IS NOT NULL
      ORDER BY member.Z_PK`);
  }

  protected record(row: Row): SchemaRecord<typeof properties> {
    return {
      collectionId: row.collectionId as string,
      assetId: row.ZASSETID as string,
      sortKey: integer(row.ZSORTKEY),
      addedAt: coreDataTime(row.ZLOCALMODDATE),
    };
  }
}
