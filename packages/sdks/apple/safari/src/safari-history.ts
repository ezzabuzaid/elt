import { type PlistValue, parseBinaryPlist } from '@workspace/codec-plist';
import { AppDatabase } from '@workspace/sdk-apple-app-database';

import { SafariSchemaError, SafariUnavailableError } from './errors.ts';
import {
  appleTime,
  counts,
  flag,
  integer,
  stored,
  storedNumber,
  text,
} from './safari-values.ts';

// The History.db columns this reader reads, checked against Safari 27 on
// macOS 27; a store without them is refused.
const historyColumns = {
  history_items: [
    'id',
    'url',
    'domain_expansion',
    'visit_count',
    'daily_visit_counts',
    'weekly_visit_counts',
    'autocomplete_triggers',
    'should_recompute_derived_visit_counts',
    'visit_count_score',
    'status_code',
  ],
  history_visits: [
    'id',
    'history_item',
    'visit_time',
    'title',
    'load_successful',
    'http_non_get',
    'synthesized',
    'redirect_source',
    'redirect_destination',
    'origin',
    'generation',
    'attributes',
    'score',
  ],
  history_tombstones: [
    'id',
    'start_time',
    'end_time',
    'url',
    'generation',
    'udid',
    'attributes',
  ],
  history_tags: [
    'id',
    'type',
    'level',
    'identifier',
    'title',
    'modification_timestamp',
    'item_count',
  ],
  history_items_to_tags: ['history_item', 'tag_id', 'timestamp'],
} as const;

const select = (table: keyof typeof historyColumns, order: string) =>
  `SELECT ${historyColumns[table].join(', ')} FROM ${table} ORDER BY ${order}`;

export type HistoryVisit = {
  readonly id: number | null;
  readonly itemId: number | null;
  readonly visitedAt: Date | null;
  readonly title: string | null;
  readonly loadSuccessful: boolean;
  readonly httpNonGet: boolean;
  readonly synthesized: boolean;
  readonly redirectSourceId: number | null;
  readonly redirectDestinationId: number | null;
  readonly origin: number | null;
  readonly generation: number | null;
  readonly attributes: number | null;
  readonly score: number | null;
};

// A URL in history, with the visit counts Safari ranks it by.
export type HistoryItem = {
  readonly id: number | null;
  readonly url: string | null;
  readonly domainExpansion: string | null;
  readonly visitCount: number | null;
  readonly visitCountScore: number | null;
  // An HTTP status Safari recorded; 0 means none.
  readonly statusCode: number | null;
  readonly derivedCountsStale: boolean;
  // The item's latest visit, whatever a reader selects.
  readonly lastVisitedAt: Date | null;
  dailyVisitCounts(): number[] | null;
  weeklyVisitCounts(): number[] | null;
  // The typed prefixes that completed to the item, a binary property list.
  autocompleteTriggers(): PlistValue | null;
};

// A deletion Safari keeps to sync to other devices: a removed URL, stored as
// text or encrypted bytes, or a cleared time range.
export type HistoryTombstone = {
  readonly id: number | null;
  readonly startAt: Date | null;
  readonly endAt: Date | null;
  readonly url: string | null;
  readonly encryptedUrl: Uint8Array | null;
  readonly generation: number | null;
  readonly deviceId: string | null;
  readonly attributes: number | null;
};

export type HistoryTag = {
  readonly id: number | null;
  readonly type: number | null;
  readonly level: number | null;
  readonly identifier: string | null;
  readonly title: string | null;
  readonly modifiedAt: Date | null;
  readonly itemCount: number | null;
};

export type HistoryItemTag = {
  readonly itemId: number | null;
  readonly tagId: number | null;
  readonly taggedAt: Date | null;
};

// One profile's History.db, read-only and pinned to one moment.
export class ProfileHistory implements Disposable {
  // The profile's external UUID; DefaultProfile for the default one.
  readonly profileId: string;
  readonly #database: AppDatabase;

  constructor(path: string, profileId: string) {
    this.profileId = profileId;
    this.#database = new AppDatabase(path, SafariUnavailableError);
    this.#database.requireColumns(historyColumns, SafariSchemaError);
  }

  visits(): HistoryVisit[] {
    return this.#database.all(select('history_visits', 'id')).map((row) => ({
      id: storedNumber(row.id),
      itemId: storedNumber(row.history_item),
      visitedAt: appleTime(row.visit_time),
      title: text(row.title),
      loadSuccessful: flag(row.load_successful),
      httpNonGet: flag(row.http_non_get),
      synthesized: flag(row.synthesized),
      redirectSourceId: integer(row.redirect_source),
      redirectDestinationId: integer(row.redirect_destination),
      origin: storedNumber(row.origin),
      generation: storedNumber(row.generation),
      attributes: storedNumber(row.attributes),
      score: storedNumber(row.score),
    }));
  }

  items(): HistoryItem[] {
    return this.#database
      .all(
        `SELECT ${historyColumns.history_items.join(', ')},
            (SELECT max(visit_time) FROM history_visits
              WHERE history_item = history_items.id) AS last_visit_time
            FROM history_items ORDER BY id`,
      )
      .map((row) => ({
        id: storedNumber(row.id),
        url: stored(row.url),
        domainExpansion: text(row.domain_expansion),
        visitCount: storedNumber(row.visit_count),
        visitCountScore: storedNumber(row.visit_count_score),
        statusCode: integer(row.status_code) || null,
        derivedCountsStale: flag(row.should_recompute_derived_visit_counts),
        lastVisitedAt: appleTime(row.last_visit_time),
        dailyVisitCounts: () => counts(row.daily_visit_counts),
        weeklyVisitCounts: () => counts(row.weekly_visit_counts),
        autocompleteTriggers: () =>
          row.autocomplete_triggers instanceof Uint8Array
            ? parseBinaryPlist(row.autocomplete_triggers)
            : null,
      }));
  }

  itemTags(): HistoryItemTag[] {
    return this.#database
      .all(select('history_items_to_tags', 'history_item, tag_id'))
      .map((row) => ({
        itemId: storedNumber(row.history_item),
        tagId: storedNumber(row.tag_id),
        taggedAt: appleTime(row.timestamp),
      }));
  }

  tags(): HistoryTag[] {
    return this.#database.all(select('history_tags', 'id')).map((row) => ({
      id: storedNumber(row.id),
      type: storedNumber(row.type),
      level: storedNumber(row.level),
      identifier: stored(row.identifier),
      title: stored(row.title),
      modifiedAt: appleTime(row.modification_timestamp),
      itemCount: storedNumber(row.item_count),
    }));
  }

  tombstones(): HistoryTombstone[] {
    return this.#database
      .all(select('history_tombstones', 'id'))
      .map((row) => ({
        id: storedNumber(row.id),
        startAt: appleTime(row.start_time),
        endAt: appleTime(row.end_time),
        url: text(row.url),
        encryptedUrl: row.url instanceof Uint8Array ? row.url : null,
        generation: storedNumber(row.generation),
        deviceId: text(row.udid),
        attributes: storedNumber(row.attributes),
      }));
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}
