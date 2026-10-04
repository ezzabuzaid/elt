import type { RecordDraft } from '@workspace/elt';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import { type Row, appleTime, flag, integer, text } from '../safari-values.ts';

const { profileId, boolean, nullableText, nullableInteger } = safariFields;

const properties = {
  profileId,
  id: {
    ...safariFields.integer,
    description:
      'History.db history_visits.id; redirectSourceId and redirectDestinationId refer to it within the same profile.',
  },
  itemId: {
    ...safariFields.integer,
    description: 'The visited URL; refers to historyItems.id.',
  },
  visitedAt: {
    ...safariFields.timestamp,
    description: 'When the visit happened.',
  },
  title: {
    ...nullableText,
    description: 'Page title at this visit; NULL when the page had none.',
  },
  loadSuccessful: {
    ...boolean,
    description: 'Whether the page finished loading.',
  },
  httpNonGet: {
    ...boolean,
    description:
      'Whether the visit was a non-GET request, such as a form POST.',
  },
  synthesized: {
    ...boolean,
    description:
      'Whether Safari synthesized the visit rather than recording a navigation.',
  },
  redirectSourceId: {
    ...nullableInteger,
    description:
      'The visit that redirected to this one; refers to historyVisits.id. NULL when none did.',
  },
  redirectDestinationId: {
    ...nullableInteger,
    description:
      'The visit this one redirected to; refers to historyVisits.id. NULL when it did not redirect.',
  },
  origin: {
    ...safariFields.ordinal,
    description:
      'Where the visit happened: 0 on this Mac, 1 on another device signed in to the same iCloud account whose history Safari synced here.',
  },
  generation: {
    ...safariFields.integer,
    description:
      'Safari history sync generation that last wrote the visit; it grows with each local change.',
  },
  attributes: {
    ...safariFields.ordinal,
    description:
      'Safari visit attribute bit mask as stored; Apple does not document the bits.',
  },
  score: {
    ...safariFields.integer,
    description: 'Safari ranking score of this visit (0 to 100 observed).',
  },
} as const;

export class HistoryVisitsStream extends SafariStream<typeof properties, Row> {
  readonly name = 'historyVisits';
  readonly store = 'history';
  readonly primaryKey = ['profileId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per page visit in Safari history (History.db history_visits), from this Mac and from other devices synced through iCloud while Safari ran. Safari removes visits older than its history retention setting. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly Row[] {
    return scan.history.flatMap((history) => history.visits);
  }

  protected record(row: Row): RecordDraft<typeof properties> {
    return {
      profileId: row.$profile,
      id: row.id,
      itemId: row.history_item,
      visitedAt: appleTime(row.visit_time),
      title: text(row.title),
      loadSuccessful: flag(row.load_successful),
      httpNonGet: flag(row.http_non_get),
      synthesized: flag(row.synthesized),
      redirectSourceId: integer(row.redirect_source),
      redirectDestinationId: integer(row.redirect_destination),
      origin: row.origin,
      generation: row.generation,
      attributes: row.attributes,
      score: row.score,
    };
  }
}
