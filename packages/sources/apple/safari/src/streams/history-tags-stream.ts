import type { RecordDraft } from '@workspace/elt';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import { type Row, appleTime } from '../safari-values.ts';

const { profileId } = safariFields;

const properties = {
  profileId,
  id: {
    ...safariFields.integer,
    description:
      'History.db history_tags.id; historyItemTags.tagId refers to it within the same profile.',
  },
  type: {
    ...safariFields.integer,
    description: 'Safari tag type as stored (1 observed: a topic).',
  },
  level: {
    ...safariFields.integer,
    description: 'Safari tag level as stored (200 observed).',
  },
  identifier: {
    ...safariFields.id,
    description:
      'The topic identifier, a Wikidata item ID such as Q2063 for topics.',
  },
  title: { ...safariFields.text, description: 'The topic name.' },
  modifiedAt: {
    ...safariFields.timestamp,
    description: 'When Safari last changed the tag.',
  },
  itemCount: {
    ...safariFields.integer,
    description:
      'Items Safari counts under the tag. Safari maintains it by trigger, so it can exceed the historyItemTags rows left after visits expire.',
  },
} as const;

export class HistoryTagsStream extends SafariStream<typeof properties, Row> {
  readonly name = 'historyTags';
  readonly store = 'history';
  readonly primaryKey = ['profileId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per topic Safari derived from browsing history (History.db history_tags). Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly Row[] {
    return scan.history.profiles.flatMap((history) => history.tags);
  }

  protected record(row: Row): RecordDraft<typeof properties> {
    return {
      profileId: row.$profile,
      id: row.id,
      type: row.type,
      level: row.level,
      identifier: row.identifier,
      title: row.title,
      modifiedAt: appleTime(row.modification_timestamp),
      itemCount: row.item_count,
    };
  }
}
