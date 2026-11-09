import type { SQLOutputValue } from 'node:sqlite';

import type { Snapshot } from '@zukhruf/sqlite-snapshot';

import { chromiumInstant } from '@eltjs/codec-chromium-time';
import type { AppDatabaseVersion } from '@eltjs/sdk-macos-app-database';

import { appDatabase } from './app-database.ts';
import { historyColumns } from './history-columns.ts';
import {
  type TransitionQualifier,
  type TransitionType,
  transitionQualifiers,
  transitionType,
} from './page-transition.ts';

type Row = Record<string, SQLOutputValue>;

const microsPerDay = 86_400_000_000n;
// Chromium removes a visit 90 days after it happened (kExpireDaysThreshold in
// history_backend.h), and the visit of a frame that loaded on its own 3 days
// sooner (kEarlyExpirationAdvanceDays in expire_history_backend.cc). A URL
// goes with its last visit.
const keptDays = 90n;
const earlyDays = 3n;

export type HistoryUrl = {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly visitCount: number;
  readonly typedCount: number;
  readonly lastVisitedAt: string | null;
  readonly hidden: boolean;
  readonly expiresAt: string | null;
};

export type HistoryVisit = {
  readonly id: number;
  readonly urlId: number;
  readonly visitedAt: string | null;
  readonly fromVisitId: number | null;
  readonly externalReferrerUrl: string | null;
  readonly transition: number;
  readonly transitionType: TransitionType | null;
  readonly transitionQualifiers: readonly TransitionQualifier[];
  readonly segmentId: number | null;
  readonly durationMicros: number;
  readonly incrementedOmniboxTypedScore: boolean;
  readonly openerVisitId: number | null;
  readonly originatorCacheGuid: string | null;
  readonly originatorVisitId: number | null;
  readonly originatorFromVisitId: number | null;
  readonly originatorOpenerVisitId: number | null;
  readonly knownToSync: boolean;
  readonly considerForNtpMostVisited: boolean;
  readonly visitedLinkId: number | null;
  readonly appId: string | null;
  readonly source: number;
  readonly context: VisitContext | null;
  readonly expiresAt: string | null;
};

// What the browser noted about a visit as it happened, in
// context_annotations. Chromium keeps it for some visits only.
export type VisitContext = {
  readonly flags: number;
  readonly durationSinceLastVisitMicros: number;
  readonly pageEndReason: number;
  readonly totalForegroundDurationMicros: number;
  readonly browserType: number;
  readonly windowId: number;
  readonly tabId: number;
  // Random 64-bit ids, past what a JavaScript number holds, as decimal text;
  // -1 is none.
  readonly taskId: string;
  readonly rootTaskId: string;
  readonly parentTaskId: string;
  readonly responseCode: number;
};

export type HistoryDownload = {
  readonly id: number;
  readonly guid: string;
  readonly currentPath: string;
  readonly targetPath: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly state: number;
  readonly dangerType: number;
  readonly interruptReason: number;
  readonly hash: string | null;
  readonly opened: boolean;
  readonly lastAccessedAt: string | null;
  readonly transient: boolean;
  readonly referrer: string | null;
  readonly siteUrl: string | null;
  readonly embedderDownloadData: string | null;
  readonly tabUrl: string | null;
  readonly tabReferrerUrl: string | null;
  readonly httpMethod: string | null;
  readonly byExtensionId: string | null;
  readonly byExtensionName: string | null;
  readonly byWebAppId: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly mimeType: string | null;
  readonly originalMimeType: string | null;
  // Each URL the download went through, redirects first, the file last.
  readonly urlChain: readonly string[];
};

export type HistorySearchTerm = {
  readonly keywordId: number;
  readonly urlId: number;
  readonly term: string;
  readonly normalizedTerm: string;
  readonly expiresAt: string | null;
};

// One profile's History, at the last commit of the browser. The browser holds
// the database with SQLite's exclusive locking mode while it runs, so the
// reader reads a checked copy. Each read gives its rows one at a time.
export interface ChromiumHistory extends Disposable {
  urls(): IteratorObject<HistoryUrl, undefined>;
  visits(): IteratorObject<HistoryVisit, undefined>;
  downloads(): IteratorObject<HistoryDownload, undefined>;
  searchTerms(): IteratorObject<HistorySearchTerm, undefined>;
}

// expires: whether the browser removes old history as Chromium does; then
// each visit, URL and search term says when it goes.
export async function openChromiumHistory(
  path: string,
  { expires }: { expires: boolean },
): Promise<ChromiumHistory> {
  const snapshot = await appDatabase.snapshotOfExclusiveOwner(path);
  // A profile that never kept history has a History with no tables.
  if (snapshot.all('SELECT name FROM sqlite_schema LIMIT 1').length === 0) {
    snapshot[Symbol.dispose]();
    return new EmptyHistory();
  }
  snapshot.requireColumns(historyColumns);
  return new StoredHistory(snapshot, expires);
}

// Changes with each commit of the browser to a profile's History.
export function chromiumHistoryVersion(path: string): AppDatabaseVersion {
  return appDatabase.versionOfExclusiveOwner(path);
}

// When the browser last committed to a profile's History.
export function chromiumHistoryLastWrite(path: string): Date {
  return appDatabase.lastWrite(path);
}

class EmptyHistory implements ChromiumHistory {
  urls() {
    return Iterator.from<HistoryUrl>([]);
  }
  visits() {
    return Iterator.from<HistoryVisit>([]);
  }
  downloads() {
    return Iterator.from<HistoryDownload>([]);
  }
  searchTerms() {
    return Iterator.from<HistorySearchTerm>([]);
  }
  [Symbol.dispose](): void {}
}

class StoredHistory implements ChromiumHistory {
  readonly #snapshot: Snapshot;
  readonly #expires: boolean;

  constructor(snapshot: Snapshot, expires: boolean) {
    this.#snapshot = snapshot;
    this.#expires = expires;
  }

  urls() {
    return this.#snapshot
      .iterate(
        `SELECT id, url, title, visit_count, typed_count,
           CAST(last_visit_time AS TEXT) AS last_visit_time, hidden
         FROM urls ORDER BY id`,
      )
      .map((row): HistoryUrl => ({
        id: integer(row.id),
        url: text(row.url),
        title: text(row.title),
        visitCount: integer(row.visit_count),
        typedCount: integer(row.typed_count),
        lastVisitedAt: instant(row.last_visit_time),
        hidden: flag(row.hidden),
        // A URL goes with its last visit, 87 days after it at the soonest.
        expiresAt: this.#expiry(row.last_visit_time, keptDays - earlyDays),
      }));
  }

  visits() {
    return this.#snapshot
      .iterate(
        `SELECT v.id, v.url, CAST(v.visit_time AS TEXT) AS visit_time,
           v.from_visit, v.external_referrer_url, v.transition, v.segment_id,
           v.visit_duration, v.incremented_omnibox_typed_score, v.opener_visit,
           v.originator_cache_guid, v.originator_visit_id,
           v.originator_from_visit, v.originator_opener_visit,
           v.is_known_to_sync, v.consider_for_ntp_most_visited,
           v.visited_link_id, v.app_id, s.source,
           c.visit_id AS context_visit_id, c.context_annotation_flags,
           c.duration_since_last_visit, c.page_end_reason,
           c.total_foreground_duration, c.browser_type, c.window_id, c.tab_id,
           CAST(c.task_id AS TEXT) AS task_id,
           CAST(c.root_task_id AS TEXT) AS root_task_id,
           CAST(c.parent_task_id AS TEXT) AS parent_task_id, c.response_code
         FROM visits v
         LEFT JOIN visit_source s ON s.id = v.id
         LEFT JOIN context_annotations c ON c.visit_id = v.id
         ORDER BY v.id`,
      )
      .map((row): HistoryVisit => {
        const transition = integer(row.transition);
        const type = transitionType(transition);
        return {
          id: integer(row.id),
          urlId: integer(row.url),
          visitedAt: instant(row.visit_time),
          fromVisitId: reference(row.from_visit),
          externalReferrerUrl: optionalText(row.external_referrer_url),
          transition,
          transitionType: type,
          transitionQualifiers: transitionQualifiers(transition),
          segmentId: reference(row.segment_id),
          durationMicros: integer(row.visit_duration),
          incrementedOmniboxTypedScore: flag(
            row.incremented_omnibox_typed_score,
          ),
          openerVisitId: reference(row.opener_visit),
          originatorCacheGuid: optionalText(row.originator_cache_guid),
          originatorVisitId: reference(row.originator_visit_id),
          originatorFromVisitId: reference(row.originator_from_visit),
          originatorOpenerVisitId: reference(row.originator_opener_visit),
          knownToSync: flag(row.is_known_to_sync),
          considerForNtpMostVisited: flag(row.consider_for_ntp_most_visited),
          visitedLinkId: reference(row.visited_link_id),
          appId: optionalText(row.app_id),
          // Chromium writes a source only for a visit the user did not
          // browse to on this device; a visit with none was browsed (1).
          source: row.source === null ? 1 : integer(row.source),
          context: row.context_visit_id === null ? null : context(row),
          expiresAt: this.#expiry(
            row.visit_time,
            type === 'auto_subframe' ? keptDays - earlyDays : keptDays,
          ),
        };
      });
  }

  downloads() {
    const chains = new Map<number, string[]>();
    for (const row of this.#snapshot.iterate(
      'SELECT id, url FROM downloads_url_chains ORDER BY id, chain_index',
    )) {
      const id = integer(row.id);
      chains.set(id, [...(chains.get(id) ?? []), text(row.url)]);
    }
    return this.#snapshot
      .iterate(
        `SELECT id, guid, current_path, target_path,
           CAST(start_time AS TEXT) AS start_time,
           CAST(end_time AS TEXT) AS end_time, received_bytes, total_bytes,
           state, danger_type, interrupt_reason, hash, opened,
           CAST(last_access_time AS TEXT) AS last_access_time, transient,
           referrer, site_url, embedder_download_data, tab_url,
           tab_referrer_url, http_method, by_ext_id, by_ext_name,
           by_web_app_id, etag, last_modified, mime_type, original_mime_type
         FROM downloads ORDER BY id`,
      )
      .map((row): HistoryDownload => ({
        id: integer(row.id),
        guid: text(row.guid),
        currentPath: text(row.current_path),
        targetPath: text(row.target_path),
        startedAt: instant(row.start_time),
        endedAt: instant(row.end_time),
        receivedBytes: integer(row.received_bytes),
        totalBytes: integer(row.total_bytes),
        state: integer(row.state),
        dangerType: integer(row.danger_type),
        interruptReason: integer(row.interrupt_reason),
        hash:
          row.hash instanceof Uint8Array && row.hash.length > 0
            ? Buffer.from(row.hash).toString('hex')
            : null,
        opened: flag(row.opened),
        lastAccessedAt: instant(row.last_access_time),
        transient: flag(row.transient),
        referrer: optionalText(row.referrer),
        siteUrl: optionalText(row.site_url),
        embedderDownloadData: optionalText(row.embedder_download_data),
        tabUrl: optionalText(row.tab_url),
        tabReferrerUrl: optionalText(row.tab_referrer_url),
        httpMethod: optionalText(row.http_method),
        byExtensionId: optionalText(row.by_ext_id),
        byExtensionName: optionalText(row.by_ext_name),
        byWebAppId: optionalText(row.by_web_app_id),
        etag: optionalText(row.etag),
        lastModified: optionalText(row.last_modified),
        mimeType: optionalText(row.mime_type),
        originalMimeType: optionalText(row.original_mime_type),
        urlChain: chains.get(integer(row.id)) ?? [],
      }));
  }

  searchTerms() {
    return this.#snapshot
      .iterate(
        `SELECT k.keyword_id, k.url_id, k.term, k.normalized_term,
           CAST(u.last_visit_time AS TEXT) AS last_visit_time
         FROM keyword_search_terms k LEFT JOIN urls u ON u.id = k.url_id
         ORDER BY k.keyword_id, k.url_id`,
      )
      .map((row): HistorySearchTerm => ({
        keywordId: integer(row.keyword_id),
        urlId: integer(row.url_id),
        term: text(row.term),
        normalizedTerm: text(row.normalized_term),
        // A search term goes with its URL.
        expiresAt: this.#expiry(row.last_visit_time, keptDays - earlyDays),
      }));
  }

  // When Chromium removes a row, days after time, to the millisecond; null
  // when the browser keeps every row. A row with no time, such as a search
  // term whose URL is gone, is past its removal time.
  #expiry(time: unknown, days: bigint): string | null {
    if (!this.#expires) return null;
    const micros = typeof time === 'string' ? BigInt(time) : 0n;
    const instant = chromiumInstant(micros + days * microsPerDay);
    return instant === null ? null : `${instant.slice(0, 23)}Z`;
  }

  [Symbol.dispose](): void {
    this.#snapshot[Symbol.dispose]();
  }
}

function context(row: Row): VisitContext {
  return {
    flags: integer(row.context_annotation_flags),
    durationSinceLastVisitMicros: integer(row.duration_since_last_visit),
    pageEndReason: integer(row.page_end_reason),
    totalForegroundDurationMicros: integer(row.total_foreground_duration),
    browserType: integer(row.browser_type),
    windowId: integer(row.window_id),
    tabId: integer(row.tab_id),
    taskId: text(row.task_id),
    rootTaskId: text(row.root_task_id),
    parentTaskId: text(row.parent_task_id),
    responseCode: integer(row.response_code),
  };
}

function integer(value: unknown): number {
  if (typeof value !== 'number')
    throw new TypeError(`History holds ${String(value)} for a number`);
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string')
    throw new TypeError(`History holds ${String(value)} for a text`);
  return value;
}

// Chromium writes an empty text for none.
function optionalText(value: unknown): string | null {
  return value === null || value === '' ? null : text(value);
}

// Chromium's ids start at 1, and it writes 0 for none.
function reference(value: unknown): number | null {
  return value === null || value === 0 ? null : integer(value);
}

function flag(value: unknown): boolean {
  return integer(value) !== 0;
}

function instant(value: unknown): string | null {
  return value === null ? null : chromiumInstant(BigInt(text(value)));
}
