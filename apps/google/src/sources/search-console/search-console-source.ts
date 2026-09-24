import {
  Catalog,
  type CopyConfiguration,
  diffSnapshot,
  isCalendarDate,
  type Partition,
  type RecordMessage,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  type Stream,
  validateRecords,
} from 'elt';

import {
  type RetryPolicy,
  SearchConsoleApi,
} from '../../platform/google/search-console-api.ts';
import {
  nextPacificMidnight,
  pageUrl,
  underProperty,
} from './inspection-scope.ts';
import {
  type Discovery,
  deletions,
  planInspections,
  readInspectionState,
} from './rolling-inspection.ts';
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
} from './search-console-schema.ts';
import { readSitemaps, type SitemapFetch } from './sitemap-urls.ts';
import {
  type InspectionClock,
  inspectionTexts,
  inspectUrls,
  systemInspectionClock,
  type UrlInspection,
} from './url-inspection.ts';

export type SearchAnalyticsType =
  | 'WEB'
  | 'IMAGE'
  | 'VIDEO'
  | 'NEWS'
  | 'DISCOVER'
  | 'GOOGLE_NEWS';

export type SearchConsoleOptions = {
  readonly requester: ConstructorParameters<typeof SearchConsoleApi>[0];
  readonly siteUrls: readonly string[];
  readonly retry?: RetryPolicy;
  readonly searchTypes?: readonly SearchAnalyticsType[];
  readonly breakdownMonths?: number;
  // A URL is inspected again once its last inspection is this old.
  readonly inspectionRefreshHours?: number;
  readonly inspectionConcurrency?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => Date;
  // Downloads the property's sitemaps; injectable for tests.
  readonly fetch?: SitemapFetch;
  readonly inspectionClock?: InspectionClock;
};

// Days of daily totals the change probe compares.
const PROBE_DAYS = 28;
// How long one property's URL universe serves the other inspection streams
// of the same pass.
const UNIVERSE_REUSE_MS = 15 * 60 * 1000;

const INSPECTION_STREAMS = new Set([
  'urlInspection',
  'urlInspectionSitemaps',
  'urlInspectionReferrers',
]);

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
  readonly siteUrls: readonly string[];
  readonly searchTypes: readonly SearchAnalyticsType[];
  readonly breakdownMonths: number;
  readonly inspectionRefreshHours: number;
  readonly inspectionConcurrency: number;
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
  readonly #fetch: SitemapFetch;
  readonly #clock: InspectionClock;
  // Inspections made by this instance, per property and URL, so the three
  // inspection streams share one API call per URL.
  readonly #inspected = new Map<string, Map<string, UrlInspection>>();
  // Each property's URL universe for the current pass: computed by the first
  // inspection stream that reads it and reused once by each of the others,
  // while it is fresh; a stream that already used it starts a new pass.
  readonly #universes = new Map<
    string,
    {
      urls: Promise<Map<string, Discovery>>;
      consumers: Set<string>;
      at: number;
    }
  >();
  // No inspection call is made for a property before this time (epoch ms),
  // after Google refused one for the daily quota.
  readonly #quotaResetAt = new Map<string, number>();
  // When each inspection stream next has a URL due, per property, learned
  // from the checkpoints its extractions received; observe() sleeps on it.
  readonly #dueAt = new Map<string, number>();

  constructor(options: SearchConsoleOptions) {
    super();
    const {
      siteUrls,
      searchTypes = SEARCH_TYPES,
      breakdownMonths = 3,
      inspectionRefreshHours = 24,
      inspectionConcurrency = 16,
      pollIntervalMs = 6 * 60 * 60 * 1000,
      now = () => new Date(),
      fetch = globalThis.fetch,
    } = options;
    if (
      !Array.isArray(siteUrls) ||
      siteUrls.length === 0 ||
      !siteUrls.every((siteUrl) => typeof siteUrl === 'string' && siteUrl) ||
      new Set(siteUrls).size !== siteUrls.length
    )
      throw new TypeError(
        'Search Console requires one or more distinct property siteUrls',
      );
    if (
      searchTypes.length === 0 ||
      new Set(searchTypes).size !== searchTypes.length ||
      !searchTypes.every((type) => SEARCH_TYPES.includes(type))
    )
      throw new TypeError('Search Console requires distinct known searchTypes');
    if (!Number.isSafeInteger(breakdownMonths) || breakdownMonths < 1)
      throw new TypeError('breakdownMonths must be at least one month');
    if (
      !(inspectionRefreshHours > 0) ||
      !Number.isFinite(inspectionRefreshHours)
    )
      throw new TypeError(
        'inspectionRefreshHours must be a positive number of hours',
      );
    if (
      !Number.isSafeInteger(inspectionConcurrency) ||
      inspectionConcurrency < 1
    )
      throw new TypeError(
        'inspectionConcurrency must be a whole number of at least one',
      );
    this.siteUrls = Object.freeze([...siteUrls]);
    this.searchTypes = Object.freeze([...searchTypes]);
    this.breakdownMonths = breakdownMonths;
    this.inspectionRefreshHours = inspectionRefreshHours;
    this.inspectionConcurrency = inspectionConcurrency;
    this.pollIntervalMs = pollIntervalMs;
    this.#now = now;
    this.#fetch = fetch;
    // Inspection times come from the same clock as every other date here.
    this.#clock = options.inspectionClock ?? {
      now: () => now().getTime(),
      sleep: systemInspectionClock.sleep,
    };
    // The report types change which rows exist, so they bind a checkpoint.
    // The window does not: it moves with the clock and state resumes it. Nor
    // do the properties: each is a partition with its own checkpoint.
    this.identity = `search-console:${this.searchTypes.join('+')}`;
    this.#api = new SearchConsoleApi(options.requester, {
      ...(options.retry ? { retry: options.retry } : {}),
    });

    this.sites = searchConsoleStream({
      name: 'sites',
      fields: sitesFields,
      primaryKey: ['siteUrl'],
      snapshot: true,
    });
    // Every stream but sites is read once per property, the partition every
    // row carries; sites is the grant's own list, the same for all of them.
    this.sitemaps = searchConsoleStream({
      name: 'sitemaps',
      partitionKey: ['siteUrl'],
      fields: sitemapsFields,
      primaryKey: ['siteUrl', 'path'],
      snapshot: true,
    });
    this.sitemapContents = searchConsoleStream({
      name: 'sitemapContents',
      partitionKey: ['siteUrl'],
      fields: sitemapContentsFields,
      primaryKey: ['siteUrl', 'sitemapPath', 'type'],
      snapshot: true,
    });
    // Every row carries its property, so several properties share one table.
    const grain = (name: SearchAnalyticsGrain): Stream =>
      searchConsoleStream({
        name,
        partitionKey: ['siteUrl'],
        fields: searchAnalyticsFields(name),
        primaryKey: ['siteUrl', ...searchAnalyticsGrains[name].key],
        // A grain carrying the date dimension resumes on it; one without is a
        // complete trailing view on every read, so incremental copies diff it.
        ...(searchAnalyticsGrains[name].dimensions.includes('date')
          ? { supportedSyncModes: ['full_refresh', 'incremental'] as const }
          : { snapshot: true }),
      });
    this.searchAnalyticsDaily = grain('searchAnalyticsDaily');
    this.searchAnalyticsQueries = grain('searchAnalyticsQueries');
    this.searchAnalyticsPages = grain('searchAnalyticsPages');
    this.searchAnalyticsCountries = grain('searchAnalyticsCountries');
    this.urlInspection = searchConsoleStream({
      name: 'urlInspection',
      partitionKey: ['siteUrl'],
      fields: urlInspectionFields,
      primaryKey: ['siteUrl', 'inspectionUrl'],
      rolling: true,
    });
    this.urlInspectionSitemaps = searchConsoleStream({
      name: 'urlInspectionSitemaps',
      partitionKey: ['siteUrl'],
      fields: urlInspectionSitemapsFields,
      primaryKey: ['siteUrl', 'inspectionUrl', 'position'],
      rolling: true,
    });
    this.urlInspectionReferrers = searchConsoleStream({
      name: 'urlInspectionReferrers',
      partitionKey: ['siteUrl'],
      fields: urlInspectionReferrersFields,
      primaryKey: ['siteUrl', 'inspectionUrl', 'position'],
      rolling: true,
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

  protected override partitions(): readonly Partition[] {
    return this.siteUrls.map((siteUrl) => ({ siteUrl }));
  }

  protected override validateExtraction(
    configuration: CopyConfiguration,
  ): void {
    if (
      configuration.syncMode === 'incremental' &&
      !configuration.stream.sourceDefinedCursor &&
      configuration.cursorField !== 'date'
    )
      throw new TypeError(
        'Search Console incremental extraction requires the date cursor',
      );
  }

  /**
   * Search Console publishes no change notification, so observation polls. A
   * tick first reads a cheap daily summary and only invalidates the analytics
   * and listing streams when the settled boundary moved or a day's totals
   * changed. Inspections do not follow traffic: the inspection streams wake
   * when their next URL falls due, a time this source learned from the
   * checkpoints its own extractions received.
   */
  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    const inspections = streams.filter((stream) =>
      INSPECTION_STREAMS.has(stream.name),
    );
    const others = streams.filter(
      (stream) => !INSPECTION_STREAMS.has(stream.name),
    );
    let fingerprint =
      others.length > 0 ? await this.#fingerprint(signal) : undefined;
    yield streams;
    let probeAt = Date.now() + this.pollIntervalMs;
    let wokeFor: number | undefined;
    while (!signal.aborted) {
      const due = this.#nextDue(inspections);
      const wake = Math.min(
        others.length > 0 ? probeAt : Number.POSITIVE_INFINITY,
        due === wokeFor ? Number.POSITIVE_INFINITY : due,
        Date.now() + this.pollIntervalMs,
      );
      await sleep(Math.max(0, wake - Date.now()), signal);
      if (signal.aborted) return;
      const changed: Stream[] = [];
      if (others.length > 0 && Date.now() >= probeAt) {
        probeAt = Date.now() + this.pollIntervalMs;
        const current = await this.#fingerprint(signal);
        if (current !== fingerprint) {
          fingerprint = current;
          changed.push(...others);
        }
      }
      // Wake once per due time; the extraction it triggers moves the time on.
      if (
        inspections.length > 0 &&
        due !== wokeFor &&
        this.#now().getTime() >= due
      ) {
        wokeFor = due;
        changed.push(...inspections);
      }
      if (changed.length > 0) yield changed;
    }
  }

  #nextDue(streams: readonly Stream[]): number {
    let due = Number.POSITIVE_INFINITY;
    for (const stream of streams)
      for (const siteUrl of this.siteUrls)
        due = Math.min(
          due,
          this.#dueAt.get(`${stream.name}\0${siteUrl}`) ??
            Number.POSITIVE_INFINITY,
        );
    return due;
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    partition: Partition | null,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    if (stream.name === 'sites') {
      yield* this.#listing(configuration, state, await this.#readSites());
      return;
    }
    const siteUrl = partition?.siteUrl;
    if (typeof siteUrl !== 'string')
      throw new TypeError(
        `Search Console stream ${stream.name} is read per property`,
      );
    if (isGrain(stream.name)) {
      yield* this.#extractAnalytics(
        stream,
        stream.name,
        configuration,
        state,
        siteUrl,
      );
      return;
    }
    if (INSPECTION_STREAMS.has(stream.name)) {
      yield* this.#extractInspections(stream, state, siteUrl);
      return;
    }
    yield* this.#listing(
      configuration,
      state,
      await this.#readSitemaps(stream.name, siteUrl),
    );
  }

  // Sites, sitemaps and the dateless grain are complete lists on every read,
  // so an incremental copy diffs them with the previous snapshot.
  async *#listing(
    { stream, syncMode }: CopyConfiguration,
    state: unknown,
    records: readonly Record<string, unknown>[],
  ): AsyncGenerator<SourceMessage> {
    if (syncMode === 'incremental')
      yield* diffSnapshot(
        stream,
        validateRecords(stream, records, 'Search Console'),
        state,
      );
    else yield* this.#records(stream, records);
  }

  *#records(
    stream: Stream,
    records: readonly Record<string, unknown>[],
  ): Generator<RecordMessage> {
    for (const data of validateRecords(stream, records, 'Search Console'))
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
    siteUrl: string,
  ): AsyncGenerator<SourceMessage> {
    const grain = searchAnalyticsGrains[name];
    const endDate = today(this.#now());
    if (!grain.dimensions.includes('date')) {
      const startDate = subMonths(endDate, this.breakdownMonths);
      const page = await readSearchAnalytics(this.#api, siteUrl, {
        dataState: 'ALL',
        dimensions: [...grain.dimensions],
        endDate,
        startDate,
        type: 'WEB',
      });
      yield* this.#listing(
        configuration,
        state,
        this.#rows(name, page.rows, siteUrl, () => ({ startDate, endDate })),
      );
      return;
    }
    const opening = subMonths(endDate, RETENTION_MONTHS);
    const saved = readCheckpoint(state);
    const startDate =
      configuration.syncMode === 'incremental'
        ? earlier(saved ?? opening, endDate)
        : opening;
    const types =
      name === 'searchAnalyticsDaily' ? this.searchTypes : (['WEB'] as const);

    let settled: string | undefined;
    for (const type of types) {
      const page = await readSearchAnalytics(this.#api, siteUrl, {
        dataState: 'ALL',
        dimensions: [...grain.dimensions],
        endDate,
        startDate,
        type,
      });
      const { firstIncompleteDate } = page;
      yield* this.#records(
        stream,
        this.#rows(name, page.rows, siteUrl, (row) => ({
          ...(name === 'searchAnalyticsDaily' ? { searchType: type } : {}),
          settled:
            firstIncompleteDate === undefined ||
            String(row.date) < firstIncompleteDate,
        })),
      );
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
    siteUrl: string,
    extra: (row: Record<string, unknown>) => Record<string, unknown>,
  ): Record<string, unknown>[] {
    const { dimensions } = searchAnalyticsGrains[name];
    return rows.flatMap((row) => {
      // A row whose keys disagree with the requested dimensions is Google's
      // doing; skipping it keeps one malformed row from failing the copy.
      if (row.keys.length !== dimensions.length) return [];
      const keyed = {
        siteUrl,
        ...Object.fromEntries(
          dimensions.map((dimension, index) => [dimension, row.keys[index]]),
        ),
      };
      return [
        {
          ...keyed,
          ...extra(keyed),
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

  async #readSitemaps(
    name: string,
    siteUrl: string,
  ): Promise<Record<string, unknown>[]> {
    const body = await this.#api.sitemaps(siteUrl);
    const sitemaps = list(body, 'sitemap');
    if (name === 'sitemaps') {
      const reads = await readSitemaps(
        this.#fetch,
        sitemaps.map((sitemap) => required(sitemap, 'path')),
      );
      return sitemaps.map((sitemap) => ({
        siteUrl,
        urlsRead: reads.get(required(sitemap, 'path'))?.urls?.length ?? null,
        readError: reads.get(required(sitemap, 'path'))?.error ?? null,
        errors: count(sitemap, 'errors'),
        isPending: flag(sitemap, 'isPending'),
        isSitemapsIndex: flag(sitemap, 'isSitemapsIndex'),
        lastDownloaded: timestamp(sitemap, 'lastDownloaded'),
        lastSubmitted: timestamp(sitemap, 'lastSubmitted'),
        path: required(sitemap, 'path'),
        type: text(sitemap, 'type'),
        warnings: count(sitemap, 'warnings'),
      }));
    }
    return sitemaps.flatMap((sitemap) =>
      list(sitemap, 'contents').map((content) => ({
        siteUrl,
        indexed: optionalCount(content, 'indexed'),
        sitemapPath: required(sitemap, 'path'),
        submitted: count(content, 'submitted'),
        type: required(content, 'type'),
      })),
    );
  }

  /**
   * One rolling pass of one inspection stream over one property: delete URLs
   * that left the universe, reuse inspections another stream already made,
   * and inspect never-inspected then stalest URLs until none is due or the
   * daily quota runs out. Progress is kept per URL in the stream's state.
   */
  async *#extractInspections(
    stream: Stream,
    state: unknown,
    siteUrl: string,
  ): AsyncGenerator<SourceMessage> {
    const saved = readInspectionState(stream, state);
    const universe = await this.#universe(siteUrl, stream.name);
    const cached = this.#inspected.get(siteUrl) ?? new Map();
    this.#inspected.set(siteUrl, cached);
    const refreshMs = this.inspectionRefreshHours * 60 * 60 * 1000;
    const plan = planInspections({
      saved,
      universe,
      cached,
      now: this.#now().getTime(),
      refreshMs,
    });
    const inspections = [...plan.reuse];
    let nextDue = plan.nextDue;
    const resetAt = this.#quotaResetAt.get(siteUrl) ?? 0;
    if (plan.due.length > 0 && this.#now().getTime() >= resetAt) {
      const { inspections: made, exhausted } = await inspectUrls(
        this.#api,
        siteUrl,
        plan.due,
        { concurrency: this.inspectionConcurrency, clock: this.#clock },
      );
      for (const inspection of made) {
        cached.set(inspection.inspectionUrl, inspection);
        nextDue = Math.min(
          nextDue,
          Date.parse(inspection.inspectedAt) + refreshMs,
        );
      }
      inspections.push(...made);
      if (exhausted) {
        const reset = nextPacificMidnight(this.#now()).getTime();
        this.#quotaResetAt.set(siteUrl, reset);
        nextDue = Math.min(nextDue, reset);
      }
    } else if (plan.due.length > 0) nextDue = Math.min(nextDue, resetAt);
    this.#dueAt.set(`${stream.name}\0${siteUrl}`, nextDue);

    const next = new Map(saved);
    for (const url of plan.gone) {
      yield* deletions(stream, siteUrl, url, 0, saved.get(url)?.rows ?? 0);
      next.delete(url);
    }
    inspections.sort((left, right) =>
      left.inspectionUrl < right.inspectionUrl ? -1 : 1,
    );
    for (const inspection of inspections) {
      const rows = this.#inspectionRows(
        stream.name,
        siteUrl,
        inspection,
        universe.get(inspection.inspectionUrl) ?? {
          sitemap: false,
          search: false,
        },
      );
      for (const data of validateRecords(stream, rows, 'Search Console'))
        yield { stream: stream.name, data };
      const before = saved.get(inspection.inspectionUrl)?.rows ?? 0;
      yield* deletions(
        stream,
        siteUrl,
        inspection.inspectionUrl,
        rows.length,
        before,
      );
      next.set(inspection.inspectionUrl, {
        at: inspection.inspectedAt,
        rows: rows.length,
      });
    }
    yield {
      type: 'STATE',
      stream: stream.name,
      state: {
        inspected: Object.fromEntries(
          [...next].sort(([left], [right]) => (left < right ? -1 : 1)),
        ),
      },
    };
  }

  #inspectionRows(
    name: string,
    siteUrl: string,
    { inspectionUrl, inspectedAt, indexStatus, result, error }: UrlInspection,
    { sitemap, search }: Discovery,
  ): Record<string, unknown>[] {
    if (name === 'urlInspection')
      return [
        {
          ampVerdict: text(record(result, 'ampResult'), 'verdict'),
          coverageState: text(indexStatus, 'coverageState'),
          crawledAs: text(indexStatus, 'crawledAs'),
          errorMessage: error?.message ?? null,
          errorStatus: error?.status ?? null,
          googleCanonical: text(indexStatus, 'googleCanonical'),
          inSearchAnalytics: search,
          inSitemap: sitemap,
          indexingState: text(indexStatus, 'indexingState'),
          inspectedAt,
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
          siteUrl,
          userCanonical: text(indexStatus, 'userCanonical'),
          verdict: text(indexStatus, 'verdict'),
        },
      ];
    const field =
      name === 'urlInspectionSitemaps' ? 'sitemap' : 'referringUrls';
    const column =
      name === 'urlInspectionSitemaps' ? 'sitemap' : 'referringUrl';
    return inspectionTexts(Reflect.get(indexStatus, field)).map(
      (value, position) => ({
        siteUrl,
        inspectionUrl,
        position,
        [column]: value,
      }),
    );
  }

  /**
   * Every URL the property can be inspected for: each URL its sitemaps list
   * and each page its search analytics history shows, fragments stripped and
   * limited to the property. The first inspection stream of a pass computes
   * it; each other stream reuses it once, so a pass reads sitemaps once.
   */
  #universe(siteUrl: string, stream: string): Promise<Map<string, Discovery>> {
    const current = this.#universes.get(siteUrl);
    const now = this.#clock.now();
    if (
      current !== undefined &&
      !current.consumers.has(stream) &&
      now - current.at < UNIVERSE_REUSE_MS
    ) {
      current.consumers.add(stream);
      return current.urls;
    }
    const urls = this.#discover(siteUrl);
    this.#universes.set(siteUrl, {
      urls,
      consumers: new Set([stream]),
      at: now,
    });
    return urls;
  }

  async #discover(siteUrl: string): Promise<Map<string, Discovery>> {
    const listed = list(await this.#api.sitemaps(siteUrl), 'sitemap').map(
      (sitemap) => required(sitemap, 'path'),
    );
    // An unreadable sitemap is reported on the sitemaps stream; inspection
    // still covers every URL the other sources show.
    const sitemapUrls = [
      ...(await readSitemaps(this.#fetch, listed)).values(),
    ].flatMap((read) => read.urls ?? []);
    const searchUrls = new Set<string>();
    const endDate = today(this.#now());
    for (const type of this.searchTypes) {
      const page = await readSearchAnalytics(this.#api, siteUrl, {
        dataState: 'ALL',
        dimensions: ['page'],
        endDate,
        startDate: subMonths(endDate, RETENTION_MONTHS),
        type,
      });
      for (const row of page.rows)
        if (row.keys[0] !== undefined) searchUrls.add(row.keys[0]);
    }
    const universe = new Map<string, Discovery>();
    const add = (raw: string, from: 'sitemap' | 'search') => {
      const url = pageUrl(raw);
      if (url === undefined || !underProperty(siteUrl, url)) return;
      const known = universe.get(url) ?? { sitemap: false, search: false };
      universe.set(url, { ...known, [from]: true });
    };
    for (const url of sitemapUrls) add(url, 'sitemap');
    for (const url of searchUrls) add(url, 'search');
    return universe;
  }

  // One probe per property; a change in any of them invalidates the streams.
  async #fingerprint(signal: AbortSignal): Promise<string> {
    const probes = [];
    for (const siteUrl of this.siteUrls) {
      signal.throwIfAborted();
      const endDate = today(this.#now());
      const page = await readSearchAnalytics(
        this.#api,
        siteUrl,
        {
          dataState: 'ALL',
          dimensions: ['date'],
          endDate,
          startDate: addDays(endDate, -PROBE_DAYS),
          type: 'WEB',
        },
        { signal },
      );
      probes.push({
        siteUrl,
        firstIncompleteDate: page.firstIncompleteDate ?? null,
        rows: page.rows.map((row) => [
          row.keys[0],
          row.clicks,
          row.impressions,
        ]),
      });
    }
    return JSON.stringify(probes);
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
