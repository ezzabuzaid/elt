import type { RecordDraft } from '@workspace/elt';
import type { HistoryItemTag } from '@workspace/sdk-apple-safari';

import type { Profiled, SafariScan } from '../safari-scan.ts';
import { SafariStream, iso, safariFields } from '../safari-stream.ts';

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
  Profiled<HistoryItemTag>
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

  protected rows(scan: SafariScan): readonly Profiled<HistoryItemTag>[] {
    return scan.history.profiles.flatMap(({ profileId, itemTags }) =>
      itemTags.map((row) => ({ profileId, row })),
    );
  }

  protected record({
    profileId,
    row,
  }: Profiled<HistoryItemTag>): RecordDraft<typeof properties> {
    return {
      profileId,
      itemId: row.itemId,
      tagId: row.tagId,
      taggedAt: iso(row.taggedAt),
    };
  }
}
