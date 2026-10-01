import type { SchemaRecord } from 'elt';
import { triggers } from '../history-reader.ts';
import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import { counts, flag, integer, type Row, text } from '../safari-values.ts';

const { profileId, id, nullableText, ordinal, boolean } = safariFields;
const countList = { type: 'integer', minimum: 0 } as const;

const properties = {
  profileId,
  id: {
    ...safariFields.integer,
    description:
      'History.db history_items.id; historyVisits.itemId and historyItemTags.itemId refer to it within the same profile.',
  },
  url: { ...safariFields.text, description: 'The page URL, unique per item.' },
  domainExpansion: {
    ...nullableText,
    description:
      'The part of the host Safari matches typed text against beyond the registrable domain, such as a subdomain; NULL when Safari recorded none.',
  },
  visitCount: {
    ...ordinal,
    description: 'Visits Safari counts for this URL across its history.',
  },
  visitCountScore: {
    ...safariFields.integer,
    description:
      'Safari ranking score derived from recent visits, used for suggestions and Top Sites.',
  },
  dailyVisitCounts: {
    type: 'array',
    items: countList,
    description:
      'Per-day values Safari stores for ranking, as stored (daily_visit_counts). They are weighted, not raw visit counts (a single visit reads 20), and Safari does not store which day the list starts on or its order.',
  },
  weeklyVisitCounts: {
    type: ['array', 'null'],
    items: countList,
    description:
      'Per-week values Safari stores for ranking, as stored (weekly_visit_counts), weighted like dailyVisitCounts; NULL until Safari has recorded any.',
  },
  autocompleteTriggers: {
    type: ['array', 'null'],
    items: { type: 'string' },
    description:
      'Typed prefixes that the user completed to this URL in the address field; NULL when none were recorded.',
  },
  statusCode: {
    ...safariFields.nullableInteger,
    description:
      'HTTP status Safari recorded for the last load; NULL when it recorded none (stored as 0).',
  },
  derivedCountsStale: {
    ...boolean,
    description:
      'Whether Safari marked visitCountScore and the count lists for recomputation.',
  },
} as const;

export class HistoryItemsStream extends SafariStream<typeof properties, Row> {
  readonly name = 'historyItems';
  readonly store = 'history';
  readonly primaryKey = ['profileId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per URL in Safari history (History.db history_items), with the visit counts Safari ranks it by. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly Row[] {
    return scan.history.flatMap((history) => history.items);
  }

  protected record(row: Row): SchemaRecord<typeof properties> {
    return {
      profileId: row.$profile as string,
      id: row.id as number,
      url: row.url as string,
      domainExpansion: text(row.domain_expansion),
      visitCount: row.visit_count as number,
      visitCountScore: row.visit_count_score as number,
      dailyVisitCounts: counts(row.daily_visit_counts) as number[],
      weeklyVisitCounts: counts(row.weekly_visit_counts),
      autocompleteTriggers: triggers(row.autocomplete_triggers) as
        | string[]
        | null,
      statusCode: integer(row.status_code) || null,
      derivedCountsStale: flag(row.should_recompute_derived_visit_counts),
    };
  }
}
