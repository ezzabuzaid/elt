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

const { boolean, nullableInteger, nullableText, nullableTimestamp } =
  booksFields;

const properties = {
  collectionId: {
    ...booksFields.id,
    description:
      'Collection identifier: a fixed name such as Finished_Collection_ID for a built-in collection, a UUID for one the user made.',
  },
  title: { ...nullableText, description: 'Collection name.' },
  details: { ...nullableText, description: 'Collection description.' },
  deleted: {
    ...boolean,
    description: 'Deleted, kept until the deletion syncs.',
  },
  hidden: { ...boolean, description: 'Hidden from the sidebar.' },
  placeholder: {
    ...boolean,
    description: 'A placeholder Books keeps for a built-in collection.',
  },
  sortKey: { ...nullableInteger, description: 'Position in the sidebar.' },
  sortMode: {
    ...nullableInteger,
    description: 'How the collection sorts its books, as a Books code.',
  },
  viewMode: {
    ...nullableInteger,
    description: 'Grid or list, as a Books code.',
  },
  modifiedAt: {
    ...nullableTimestamp,
    description: 'When the collection last changed.',
  },
  localModifiedAt: {
    ...nullableTimestamp,
    description: 'When the collection last changed on this Mac.',
  },
} as const;

export class CollectionsStream extends BooksStream<typeof properties, Row> {
  readonly name = 'collections';
  readonly store = 'library';
  readonly primaryKey = ['collectionId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per Books collection, built-in or made by the user; members are in collectionMembers. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: BooksScan): readonly Row[] {
    return scan.library.all(
      'SELECT * FROM ZBKCOLLECTION WHERE ZCOLLECTIONID IS NOT NULL ORDER BY Z_PK',
    );
  }

  protected record(row: Row): RecordDraft<typeof properties> {
    return {
      collectionId: row.ZCOLLECTIONID,
      title: text(row.ZTITLE),
      details: text(row.ZDETAILS),
      deleted: flag(row.ZDELETEDFLAG),
      hidden: flag(row.ZHIDDEN),
      placeholder: flag(row.ZPLACEHOLDER),
      sortKey: integer(row.ZSORTKEY),
      sortMode: integer(row.ZSORTMODE),
      viewMode: integer(row.ZVIEWMODE),
      modifiedAt: coreDataTime(row.ZLASTMODIFICATION),
      localModifiedAt: coreDataTime(row.ZLOCALMODDATE),
    };
  }
}
