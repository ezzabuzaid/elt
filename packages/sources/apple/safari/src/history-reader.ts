import {
  type PlistValue,
  isDictionary,
  parseBinaryPlist,
} from '@workspace/macos-plist';
import {
  type ImportScope,
  selected,
  withinDates,
} from '@workspace/source-apple-macos/import-scope';

import type { SafariDatabase } from './safari-store.ts';
import { type Row, appleTime } from './safari-values.ts';

// The History.db columns this connector reads, checked against Safari 27 on
// macOS 27; SafariDatabase.open refuses a store without them.
export const historyColumns = {
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

// One run's read of Safari history: each profile's History.db, and the instant
// Safari keeps visits from.
export type SafariHistory = {
  readonly profiles: readonly HistoryReader[];
  readonly horizon: string;
};

const dayMs = 86_400_000;
// "Remove history items" in Safari's General settings. Its menu stores 1, 7,
// 14, 30 or 365 days as HistoryAgeInDaysLimit, and Safari keeps a year while
// the key is unset. Manually stores no positive limit: Safari then keeps
// visits until they are removed.
const defaultHistoryAgeInDays = 365;
const forever = Date.UTC(1, 0, 1);
// Safari prunes by its own clock before a read sees the result; an hour inside
// the limit absorbs a daylight-saving shift.
const marginMs = 3_600_000;

// The instant Safari keeps visits from at startedAt, from its preferences.
export function historyHorizon(
  preferences: PlistValue | null,
  startedAt: Date,
): string {
  const configured = isDictionary(preferences)
    ? preferences.HistoryAgeInDaysLimit
    : undefined;
  const limit = configured ?? defaultHistoryAgeInDays;
  if (typeof limit !== 'number')
    throw new TypeError('Safari HistoryAgeInDaysLimit is not a number');
  return new Date(
    limit > 0
      ? Math.max(forever, startedAt.getTime() - limit * dayMs + marginMs)
      : forever,
  ).toISOString();
}

// One run's read of one profile's History.db; each row carries its profile as
// $profile. The scope's profiles and dates select visits, and items, tags and
// tag links follow the visits kept.
export class HistoryReader {
  readonly database: SafariDatabase;
  readonly profileId: string;
  readonly scope: ImportScope;
  #visits?: Row[];
  #items?: Row[];
  #itemTags?: Row[];
  #tags?: Row[];

  constructor(database: SafariDatabase, profileId: string, scope: ImportScope) {
    this.database = database;
    this.profileId = profileId;
    this.scope = scope;
  }

  get #included(): boolean {
    return selected(this.scope.collectionIds, this.profileId);
  }

  #all(sql: string): Row[] {
    return this.database
      .all(sql)
      .map((row) => ({ ...row, $profile: this.profileId }));
  }

  get #dated(): boolean {
    return this.scope.startAt !== undefined || this.scope.endAt !== undefined;
  }

  get visits(): Row[] {
    this.#visits ??= this.#included
      ? this.#all(select('history_visits', 'id')).filter((row) =>
          withinDates(this.scope, appleTime(row.visit_time)),
        )
      : [];
    return this.#visits;
  }

  get items(): Row[] {
    if (this.#items !== undefined) return this.#items;
    const visited = new Set(this.visits.map((visit) => visit.history_item));
    this.#items = this.#included
      ? this.#all(
          `SELECT ${historyColumns.history_items.join(', ')},
            (SELECT max(visit_time) FROM history_visits
              WHERE history_item = history_items.id) AS last_visit_time
            FROM history_items ORDER BY id`,
        ).filter((row) => !this.#dated || visited.has(row.id))
      : [];
    return this.#items;
  }

  get itemTags(): Row[] {
    if (this.#itemTags !== undefined) return this.#itemTags;
    const items = new Set(this.items.map((item) => item.id));
    this.#itemTags = this.#included
      ? this.#all(
          select('history_items_to_tags', 'history_item, tag_id'),
        ).filter((row) => items.has(row.history_item))
      : [];
    return this.#itemTags;
  }

  get tags(): Row[] {
    if (this.#tags !== undefined) return this.#tags;
    const linked = new Set(this.itemTags.map((link) => link.tag_id));
    this.#tags = this.#included
      ? this.#all(select('history_tags', 'id')).filter(
          (row) => !this.#dated || linked.has(row.id),
        )
      : [];
    return this.#tags;
  }

  // Tombstones record deletions to sync to other devices, whatever their date.
  get tombstones(): Row[] {
    return this.#included ? this.#all(select('history_tombstones', 'id')) : [];
  }
}

// An item's autocomplete triggers: a binary property list of the typed
// prefixes that completed to it.
export const triggers = (value: Row[string] | undefined) =>
  value instanceof Uint8Array ? parseBinaryPlist(value) : null;
