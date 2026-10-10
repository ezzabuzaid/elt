import { isCalendarDate } from '@workspace/elt';

import type {
  CallOptions,
  SearchAnalyticsRequest,
  SearchConsoleApi,
} from './search-console-api.ts';

export const SEARCH_ANALYTICS_ROW_LIMIT = 25_000;

export type SearchAnalyticsRow = {
  readonly keys: readonly string[];
  readonly clicks: number;
  readonly impressions: number;
  readonly ctr: number;
  // Discover and Google News omit position on every row, including
  // zero-traffic ones. Absent means unranked, not rank one.
  readonly position: number | null;
};

export type SearchAnalyticsPage = {
  readonly rows: readonly SearchAnalyticsRow[];
  // The first date still being collected, as the API reports it. Data before
  // it is settled; data from it onwards may still be restated.
  readonly firstIncompleteDate?: string;
};

export const PACIFIC = 'America/Los_Angeles';

// The calendar day Search Console reports at now: Pacific Time, not UTC.
export function today(now: Date): string {
  return Temporal.Instant.fromEpochMilliseconds(now.getTime())
    .toZonedDateTimeISO(PACIFIC)
    .toPlainDate()
    .toString();
}

export function addDays(date: string, days: number): string {
  return calendarDate(date).add({ days }).toString();
}

/**
 * Calendar months, clamped to the end of a shorter month: sixteen months
 * before 31 March is 30 November, and an unclamped subtraction would roll
 * into December and drop a month of history. Counting fixed-length days
 * drifts for the same reason.
 */
export function subMonths(date: string, months: number): string {
  return calendarDate(date).subtract({ months }).toString();
}

// Temporal also reads a date with a time; Google's dates carry none.
function calendarDate(date: string): Temporal.PlainDate {
  if (!isCalendarDate(date)) throw new TypeError(`Invalid date: ${date}`);
  return Temporal.PlainDate.from(date);
}

export function earlier(left: string, right: string): string {
  return left < right ? left : right;
}

/**
 * Every row for one request, following `startRow` until a short page. Returns
 * the metadata alongside, because the incomplete-date boundary is what lets a
 * caller advance a checkpoint without guessing a lookback.
 */
export async function readSearchAnalytics(
  api: SearchConsoleApi,
  siteUrl: string,
  request: SearchAnalyticsRequest,
  options: CallOptions = {},
): Promise<SearchAnalyticsPage> {
  const rows: SearchAnalyticsRow[] = [];
  const rowLimit = request.rowLimit ?? SEARCH_ANALYTICS_ROW_LIMIT;
  let firstIncompleteDate: string | undefined;
  let startRow = request.startRow ?? 0;
  for (;;) {
    const page = await api.searchAnalytics(
      siteUrl,
      { ...request, rowLimit, startRow },
      options,
    );
    firstIncompleteDate ??= page.metadata?.firstIncompleteDate;
    // An exhausted range answers without a rows field at all.
    const pageRows = page.rows ?? [];
    rows.push(
      ...pageRows.map((row) => ({ ...row, position: row.position ?? null })),
    );
    if (pageRows.length < rowLimit) break;
    startRow += pageRows.length;
  }
  return { rows, ...(firstIncompleteDate ? { firstIncompleteDate } : {}) };
}
