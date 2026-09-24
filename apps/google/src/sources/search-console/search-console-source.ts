import {
  Catalog,
  type CopyConfiguration,
  isCalendarDate,
  type RecordMessage,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  type Stream,
} from 'elt';

import {
  type RetryPolicy,
  SearchConsoleApi,
} from '../../platform/google/search-console-api.ts';
import {
  addDays,
  earlier,
  readSearchAnalytics,
  type SearchAnalyticsRow,
  subMonths,
  today,
} from './search-analytics-query.ts';
import {
  type SearchAnalyticsGrain,
  searchAnalyticsFields,
  searchAnalyticsGrains,
  searchConsoleStream,
  sitemapContentsFields,
  sitemapsFields,
  sitesFields,
  urlInspectionFields,
  urlInspectionReferrersFields,
  urlInspectionSitemapsFields,
  validateSearchConsoleRecords,
} from './search-console-schema.ts';
import { inspectionTexts, inspectUrls } from './url-inspection.ts';

export type SearchAnalyticsType =
  | 'WEB'
  | 'IMAGE'
  | 'VIDEO'
  | 'NEWS'
  | 'DISCOVER'
  | 'GOOGLE_NEWS';

export type SearchConsoleOptions = {
  readonly requester: ConstructorParameters<typeof SearchConsoleApi>[0];
  readonly siteUrl: string;
  readonly retry?: RetryPolicy;
  readonly searchTypes?: readonly SearchAnalyticsType[];
  readonly breakdownMonths?: number;
  readonly inspectionLimit?: number;
  readonly inspectionWindowDays?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => Date;
};

const SEARCH_TYPES = [
  'WEB',
  'IMAGE',
  'VIDEO',
  'NEWS',
  'DISCOVER',
  'GOOGLE_NEWS',
] as const satisfies readonly SearchAnalyticsType[];

// Search Console keeps the last sixteen months of performance data.
const RETENTION_MONTHS = 16;

const GRAIN_NAMES = Object.keys(
  searchAnalyticsGrains,
) as readonly SearchAnalyticsGrain[];

function isGrain(name: string): name is SearchAnalyticsGrain {
  return Object.hasOwn(searchAnalyticsGrains, name);
}

export class SearchConsoleSource extends Source {
  readonly identity: string;
  readonly siteUrl: string;
  readonly searchTypes: readonly SearchAnalyticsType[];
  readonly breakdownMonths: number;
  readonly inspectionLimit: number;
  readonly inspectionWindowDays: number;
  readonly pollIntervalMs: number;

  readonly sites: Stream;
  readonly sitemaps: Stream;
  readonly sitemapContents: Stream;
  readonly searchAnalyticsDaily: Stream;
  readonly searchAnalyticsQueries: Stream;
  readonly searchAnalyticsPages: Stream;
  readonly searchAnalyticsCountries: Stream;
  readonly urlInspection: Stream;
  readonly urlInspectionSitemaps: Stream;
  readonly urlInspectionReferrers: Stream;

  readonly #api: SearchConsoleApi;
  protected readonly catalog: Catalog;
  readonly #now: () => Date;
  readonly #inspections = new Map<
    string,
    Awaited<ReturnType<typeof inspectUrls>>
  >();

  constructor(options: SearchConsoleOptions) {
    super();
    const {
      siteUrl,
      searchTypes = SEARCH_TYPES,
      breakdownMonths = 3,
      inspectionLimit = 200,
      inspectionWindowDays = 28,
      pollIntervalMs = 6 * 60 * 60 * 1000,
      now = () => new Date(),
    } = options;
    if (typeof siteUrl !== 'string' || !siteUrl)
      throw new TypeError('Search Console requires a property siteUrl');
    if (
      searchTypes.length === 0 ||
      new Set(searchTypes).size !== searchTypes.length ||
      !searchTypes.every((type) => SEARCH_TYPES.includes(type))
    )
      throw new TypeError('Search Console requires distinct known searchTypes');
    if (!Number.isSafeInteger(breakdownMonths) || breakdownMonths < 1)
      throw new TypeError('breakdownMonths must be at least one month');
    if (!Number.isSafeInteger(inspectionLimit) || inspectionLimit < 0)
      throw new TypeError('inspectionLimit must be a whole number of URLs');
    if (!Number.isSafeInteger(inspectionWindowDays) || inspectionWindowDays < 1)
      throw new TypeError('inspectionWindowDays must be at least one day');
    this.siteUrl = siteUrl;
    this.searchTypes = Object.freeze([...searchTypes]);
    this.breakdownMonths = breakdownMonths;
    this.inspectionLimit = inspectionLimit;
    this.inspectionWindowDays = inspectionWindowDays;
    this.pollIntervalMs = pollIntervalMs;
    this.#now = now;
    // The report types change which rows exist, so they bind a checkpoint.
    // The window does not: it moves with the clock and state resumes it.
    this.identity = `search-console:${siteUrl}:${this.searchTypes.join('+')}`;
    this.#api = new SearchConsoleApi(options.requester, {
      ...(options.retry ? { retry: options.retry } : {}),
    });

    this.sites = searchConsoleStream({
      name: 'sites',
      fields: sitesFields,
      primaryKey: ['siteUrl'],
    });
    this.sitemaps = searchConsoleStream({
      name: 'sitemaps',
      fields: sitemapsFields,
      primaryKey: ['path'],
    });
    this.sitemapContents = searchConsoleStream({
      name: 'sitemapContents',
      fields: sitemapContentsFields,
      primaryKey: ['sitemapPath', 'type'],
    });
    const grain = (name: SearchAnalyticsGrain): Stream =>
      searchConsoleStream({
        name,
        fields: searchAnalyticsFields(name),
        primaryKey: [...searchAnalyticsGrains[name].key],
        // Only a grain carrying the date dimension has a cursor to resume on.
        supportedSyncModes: searchAnalyticsGrains[name].dimensions.includes(
          'date',
        )
          ? ['full_refresh', 'incremental']
          : ['full_refresh'],
      });
    this.searchAnalyticsDaily = grain('searchAnalyticsDaily');
    this.searchAnalyticsQueries = grain('searchAnalyticsQueries');
    this.searchAnalyticsPages = grain('searchAnalyticsPages');
    this.searchAnalyticsCountries = grain('searchAnalyticsCountries');
    this.urlInspection = searchConsoleStream({
      name: 'urlInspection',
      fields: urlInspectionFields,
      primaryKey: ['inspectionUrl'],
    });
    this.urlInspectionSitemaps = searchConsoleStream({
      name: 'urlInspectionSitemaps',
      fields: urlInspectionSitemapsFields,
      primaryKey: ['inspectionUrl', 'position'],
    });
    this.urlInspectionReferrers = searchConsoleStream({
      name: 'urlInspectionReferrers',
      fields: urlInspectionReferrersFields,
      primaryKey: ['inspectionUrl', 'position'],
    });
    this.catalog = new Catalog([
      this.sites,
      this.sitemaps,
      this.sitemapContents,
      this.searchAnalyticsDaily,
      this.searchAnalyticsQueries,
      this.searchAnalyticsPages,
      this.searchAnalyticsCountries,
      this.urlInspection,
      this.urlInspectionSitemaps,
      this.urlInspectionReferrers,
    ]);
    Object.freeze(this);
  }

  protected override validateExtraction(
    configuration: CopyConfiguration,
  ): void {
    if (
      configuration.syncMode === 'incremental' &&
      configuration.cursorField !== 'date'
    )
      throw new TypeError(
        'Search Console incremental extraction requires the date cursor',
      );
  }

  /**
   * Search Console publishes no change notification, so observation polls. A
   * tick first reads a cheap daily summary and only invalidates when the
   * settled boundary moved or a day's totals changed, which keeps an unchanged
   * property from re-extracting every row.
   */
  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    let fingerprint = await this.#fingerprint(signal);
    yield streams;
    while (!signal.aborted) {
      await sleep(this.pollIntervalMs, signal);
      if (signal.aborted) return;
      const current = await this.#fingerprint(signal);
      if (current === fingerprint) continue;
      fingerprint = current;
      yield streams;
    }
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    if (isGrain(stream.name)) {
      yield* this.#extractAnalytics(stream, stream.name, configuration, state);
      return;
    }
    switch (stream.name) {
      case 'sites':
        yield* this.#records(stream, await this.#readSites());
        return;
      case 'sitemaps':
      case 'sitemapContents':
        yield* this.#records(stream, await this.#readSitemaps(stream.name));
        return;
      default:
        yield* this.#records(stream, await this.#readInspections(stream.name));
        return;
    }
  }

  *#records(
    stream: Stream,
    records: readonly Record<string, unknown>[],
  ): Generator<RecordMessage> {
    for (const data of validateSearchConsoleRecords(stream, records))
      yield { stream: stream.name, data };
  }

  /**
   * One grain, one window. The daily totals repeat per report type and carry
   * it as data; the breakdowns are web-only, because Google anonymizes rare
   * rows and a wider grain loses more of the property's real traffic.
   */
  async *#extractAnalytics(
    stream: Stream,
    name: SearchAnalyticsGrain,
    configuration: CopyConfiguration,
    state: unknown,
  ): AsyncGenerator<SourceMessage> {
    const grain = searchAnalyticsGrains[name];
    const endDate = today(this.#now());
    const resumable = grain.dimensions.includes('date');
    const opening = subMonths(
      endDate,
      resumable ? RETENTION_MONTHS : this.breakdownMonths,
    );
    const saved = readCheckpoint(state);
    const startDate =
      configuration.syncMode === 'incremental'
        ? earlier(saved ?? opening, endDate)
        : opening;
    const types =
      name === 'searchAnalyticsDaily' ? this.searchTypes : (['WEB'] as const);

    let settled: string | undefined;
    for (const type of types) {
      const page = await readSearchAnalytics(this.#api, this.siteUrl, {
        dataState: 'ALL',
        dimensions: [...grain.dimensions],
        endDate,
        startDate,
        type,
      });
      yield* this.#records(stream, this.#rows(name, page.rows, type));
      if (page.firstIncompleteDate === undefined) continue;
      // Report types settle independently, so the checkpoint keeps the
      // earliest boundary and re-reads the rest next run.
      const boundary = addDays(page.firstIncompleteDate, -1);
      settled = settled === undefined ? boundary : earlier(settled, boundary);
    }
    if (configuration.syncMode !== 'incremental') return;
    yield {
      type: 'STATE',
      stream: stream.name,
      state: { date: earlier(settled ?? endDate, endDate) },
    };
  }

  #rows(
    name: SearchAnalyticsGrain,
    rows: readonly SearchAnalyticsRow[],
    type: SearchAnalyticsType,
  ): Record<string, unknown>[] {
    const { dimensions, extra } = searchAnalyticsGrains[name];
    return rows.flatMap((row) => {
      // A row whose keys disagree with the requested dimensions is Google's
      // doing; skipping it keeps one malformed row from failing the copy.
      if (row.keys.length !== dimensions.length) return [];
      return [
        {
          ...Object.fromEntries(
            dimensions.map((dimension, index) => [dimension, row.keys[index]]),
          ),
          ...(extra === undefined ? {} : { searchType: type }),
          clicks: row.clicks,
          ctr: row.ctr,
          impressions: row.impressions,
          position: row.position,
        },
      ];
    });
  }

  /**
   * Properties the grant can read. An unverified user is listed but cannot
   * read a property's history, so it is not one this connector can extract.
   */
  async #readSites(): Promise<Record<string, unknown>[]> {
    const body = await this.#api.sites();
    return list(body, 'siteEntry')
      .filter(
        (entry) => text(entry, 'permissionLevel') !== 'siteUnverifiedUser',
      )
      .map((entry) => ({
        permissionLevel: text(entry, 'permissionLevel'),
        siteUrl: required(entry, 'siteUrl'),
      }));
  }

  async #readSitemaps(name: string): Promise<Record<string, unknown>[]> {
    const body = await this.#api.sitemaps(this.siteUrl);
    const sitemaps = list(body, 'sitemap');
    if (name === 'sitemaps')
      return sitemaps.map((sitemap) => ({
        errors: count(sitemap, 'errors'),
        isPending: flag(sitemap, 'isPending'),
        isSitemapsIndex: flag(sitemap, 'isSitemapsIndex'),
        lastDownloaded: timestamp(sitemap, 'lastDownloaded'),
        lastSubmitted: timestamp(sitemap, 'lastSubmitted'),
        path: required(sitemap, 'path'),
        type: text(sitemap, 'type'),
        warnings: count(sitemap, 'warnings'),
      }));
    return sitemaps.flatMap((sitemap) =>
      list(sitemap, 'contents').map((content) => ({
        indexed: optionalCount(content, 'indexed'),
        sitemapPath: required(sitemap, 'path'),
        submitted: count(content, 'submitted'),
        type: required(content, 'type'),
      })),
    );
  }

  async #readInspections(name: string): Promise<Record<string, unknown>[]> {
    const inspections = await this.#inspect();
    if (name === 'urlInspection')
      return inspections.map(({ inspectionUrl, indexStatus, result }) => ({
        ampVerdict: text(record(result, 'ampResult'), 'verdict'),
        coverageState: text(indexStatus, 'coverageState'),
        crawledAs: text(indexStatus, 'crawledAs'),
        googleCanonical: text(indexStatus, 'googleCanonical'),
        indexingState: text(indexStatus, 'indexingState'),
        inspectionResultLink: text(result, 'inspectionResultLink'),
        inspectionUrl,
        lastCrawlTime: timestamp(indexStatus, 'lastCrawlTime'),
        mobileUsabilityVerdict: text(
          record(result, 'mobileUsabilityResult'),
          'verdict',
        ),
        pageFetchState: text(indexStatus, 'pageFetchState'),
        richResultsVerdict: text(
          record(result, 'richResultsResult'),
          'verdict',
        ),
        robotsTxtState: text(indexStatus, 'robotsTxtState'),
        siteUrl: this.siteUrl,
        userCanonical: text(indexStatus, 'userCanonical'),
        verdict: text(indexStatus, 'verdict'),
      }));
    const field =
      name === 'urlInspectionSitemaps' ? 'sitemap' : 'referringUrls';
    const column =
      name === 'urlInspectionSitemaps' ? 'sitemap' : 'referringUrl';
    return inspections.flatMap(({ inspectionUrl, indexStatus }) =>
      inspectionTexts(Reflect.get(indexStatus, field)).map(
        (value, position) => ({
          inspectionUrl,
          position,
          [column]: value,
        }),
      ),
    );
  }

  async #inspect(): Promise<Awaited<ReturnType<typeof inspectUrls>>> {
    const urls = await this.#topPages();
    const key = JSON.stringify(urls);
    const cached = this.#inspections.get(key);
    if (cached) return cached;
    this.#inspections.clear();
    const inspections = await inspectUrls(this.#api, this.siteUrl, urls);
    this.#inspections.set(key, inspections);
    return inspections;
  }

  async #topPages(): Promise<readonly string[]> {
    if (this.inspectionLimit === 0) return [];
    const endDate = today(this.#now());
    const page = await readSearchAnalytics(this.#api, this.siteUrl, {
      dataState: 'ALL',
      dimensions: ['page'],
      endDate,
      rowLimit: this.inspectionLimit,
      startDate: addDays(endDate, -this.inspectionWindowDays),
      type: 'WEB',
    });
    return Object.freeze(
      [...page.rows]
        .sort((left, right) => right.impressions - left.impressions)
        .slice(0, this.inspectionLimit)
        .map((row) => row.keys[0] ?? ''),
    );
  }

  async #fingerprint(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const endDate = today(this.#now());
    const page = await readSearchAnalytics(
      this.#api,
      this.siteUrl,
      {
        dataState: 'ALL',
        dimensions: ['date'],
        endDate,
        startDate: addDays(endDate, -this.inspectionWindowDays),
        type: 'WEB',
      },
      { signal },
    );
    return JSON.stringify({
      firstIncompleteDate: page.firstIncompleteDate ?? null,
      rows: page.rows.map((row) => [row.keys[0], row.clicks, row.impressions]),
    });
  }
}

export { GRAIN_NAMES };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}

function readCheckpoint(state: unknown): string | null {
  if (state === null || state === undefined) return null;
  if (
    typeof state !== 'object' ||
    Array.isArray(state) ||
    Object.keys(state).length !== 1 ||
    !Object.hasOwn(state, 'date')
  )
    throw new TypeError('Invalid Search Console checkpoint');
  const date: unknown = Reflect.get(state, 'date');
  if (!isCalendarDate(date))
    throw new TypeError('Invalid Search Console checkpoint date');
  return date;
}

function record(value: unknown, key: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return {};
  const nested: unknown = Reflect.get(value, key);
  return nested !== null && typeof nested === 'object'
    ? (nested as Record<string, unknown>)
    : {};
}

function list(value: unknown, key: string): Record<string, unknown>[] {
  if (value === null || typeof value !== 'object') return [];
  const entries: unknown = Reflect.get(value, key);
  if (entries === undefined) return [];
  if (!Array.isArray(entries))
    throw new TypeError(`Search Console returned an invalid ${key} list`);
  return entries.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object')
      throw new TypeError(`Search Console returned an invalid ${key} entry`);
    return entry as Record<string, unknown>;
  });
}

function required(value: object, key: string): string {
  const text: unknown = Reflect.get(value, key);
  if (typeof text !== 'string' || !text)
    throw new TypeError(`Search Console returned no ${key}`);
  return text;
}

function text(value: object, key: string): string | null {
  const found: unknown = Reflect.get(value, key);
  if (found === undefined || found === null) return null;
  if (typeof found !== 'string')
    throw new TypeError(`Search Console returned an invalid ${key}`);
  return found;
}

// int64 fields arrive as decimal strings, and proto3 omits a zero entirely.
function count(value: object, key: string): number {
  return optionalCount(value, key) ?? 0;
}

function optionalCount(value: object, key: string): number | null {
  const found: unknown = Reflect.get(value, key);
  if (found === undefined || found === null) return null;
  const parsed = typeof found === 'string' ? Number(found) : found;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0)
    throw new TypeError(`Search Console returned an invalid ${key}`);
  return parsed;
}

function flag(value: object, key: string): boolean {
  const found: unknown = Reflect.get(value, key);
  if (found === undefined || found === null) return false;
  if (typeof found !== 'boolean')
    throw new TypeError(`Search Console returned an invalid ${key}`);
  return found;
}

// RFC 3339 without milliseconds is valid here, so normalize before loading.
function timestamp(value: object, key: string): string | null {
  const found: unknown = Reflect.get(value, key);
  if (found === undefined || found === null) return null;
  if (typeof found !== 'string')
    throw new TypeError(`Search Console returned an invalid ${key}`);
  const parsed = Date.parse(found);
  if (!Number.isFinite(parsed))
    throw new TypeError(`Search Console returned an unparsable ${key}`);
  return new Date(parsed).toISOString();
}
