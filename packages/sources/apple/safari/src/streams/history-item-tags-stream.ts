import type { RecordDraft } from '@workspace/elt';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import { type Row, appleTime } from '../safari-values.ts';

const properties = {
  profileId: safariFields.profileId,
  itemId: {
    ...safariFields.integer,
    description: 'The tagged URL; refers to historyItems.id.',
  },
  tagId: {
    ...safariFields.integer,
    description: 'The topic; refers to historyTags.id.',
  },
  taggedAt: {
    ...safariFields.timestamp,
    description: 'When Safari tagged the item.',
  },
} as const;

export class HistoryItemTagsStream extends SafariStream<
  typeof properties,
  Row
> {
  readonly name = 'historyItemTags';
  readonly store = 'history';
  readonly primaryKey = ['profileId', 'itemId', 'tagId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per topic Safari assigned to a history item (History.db history_items_to_tags). Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly Row[] {
    return scan.history.flatMap((history) => history.itemTags);
  }

  protected record(row: Row): RecordDraft<typeof properties> {
    return {
      profileId: row.$profile,
      itemId: row.history_item,
      tagId: row.tag_id,
      taggedAt: appleTime(row.timestamp),
    };
  }
}
