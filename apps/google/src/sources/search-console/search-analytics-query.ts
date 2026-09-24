import { isCalendarDate } from 'elt';
import type {
  CallOptions,
  SearchAnalyticsRequest,
  SearchConsoleApi,
} from '../../platform/google/search-console-api.ts';

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

export function today(now: Date = new Date()): string {
  const iso = now.toISOString();
  return iso.slice(0, iso.indexOf('T'));
}

export function addDays(date: string, days: number): string {
  if (!isCalendarDate(date)) throw new TypeError(`Invalid date: ${date}`);
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return today(shifted);
}

/**
 * Calendar months, clamped to the end of a shorter month: sixteen months
 * before 31 March is 30 November, and an unclamped subtraction would roll
 * into December and drop a month of history. Counting fixed-length days
 * drifts for the same reason.
 */
export function subMonths(date: string, months: number): string {
  if (!isCalendarDate(date)) throw new TypeError(`Invalid date: ${date}`);
  const shifted = new Date(`${date}T00:00:00.000Z`);
  const day = shifted.getUTCDate();
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() - months);
  const lastDay = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
  ).getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDay));
  return today(shifted);
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
    const page = parsePage(
      await api.searchAnalytics(
        siteUrl,
        { ...request, rowLimit, startRow },
        options,
      ),
    );
    firstIncompleteDate ??= page.firstIncompleteDate;
    rows.push(...page.rows);
    if (page.rows.length < rowLimit) break;
    startRow += page.rows.length;
  }
  return { rows, ...(firstIncompleteDate ? { firstIncompleteDate } : {}) };
}

function parsePage(body: unknown): SearchAnalyticsPage {
  if (body === null || typeof body !== 'object')
    throw new TypeError('Search Console returned an invalid analytics page');
  const rawRows: unknown = Reflect.get(body, 'rows');
  // An exhausted range answers without a rows field at all.
  if (rawRows !== undefined && !Array.isArray(rawRows))
    throw new TypeError('Search Console returned invalid analytics rows');
  const rows = (rawRows ?? []).map((row: unknown) => {
    if (row === null || typeof row !== 'object')
      throw new TypeError('Search Console returned an invalid analytics row');
    // A query with no dimensions answers with a single keyless total row.
    const keys: unknown = Reflect.get(row, 'keys') ?? [];
    if (!Array.isArray(keys) || !keys.every((key) => typeof key === 'string'))
      throw new TypeError('Search Console returned invalid analytics keys');
    // Proto3 JSON omits a zero, so an absent count means none were recorded.
    // Position is different: it is absent because there is no rank to report.
    return {
      keys: keys as readonly string[],
      clicks: metric(row, 'clicks'),
      impressions: metric(row, 'impressions'),
      ctr: metric(row, 'ctr'),
      position: optionalMetric(row, 'position'),
    };
  });
  const metadata: unknown = Reflect.get(body, 'metadata');
  const incomplete: unknown =
    metadata !== null && typeof metadata === 'object'
      ? Reflect.get(metadata, 'firstIncompleteDate')
      : undefined;
  if (incomplete !== undefined && !isCalendarDate(incomplete))
    throw new TypeError(
      'Search Console returned an invalid firstIncompleteDate',
    );
  return {
    rows,
    ...(typeof incomplete === 'string'
      ? { firstIncompleteDate: incomplete }
      : {}),
  };
}

function metric(row: object, name: string): number {
  return optionalMetric(row, name) ?? 0;
}

function optionalMetric(row: object, name: string): number | null {
  const value: unknown = Reflect.get(row, name);
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError(`Search Console returned an invalid ${name}`);
  return value;
}
