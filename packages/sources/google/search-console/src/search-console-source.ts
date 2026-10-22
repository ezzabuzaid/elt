import { setTimeout as sleep } from 'node:timers/promises';

import {
  Catalog,
  type CopyConfiguration,
  type ExtractionCoverage,
  type FailureType,
  type Partition,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  type Stream,
} from '@workspace/elt';
import {
  GoogleGrantRevokedError,
  messageOf,
  statusOf,
} from '@workspace/google-auth';
import {
  SearchConsoleApi,
  readSearchAnalytics,
  today,
} from '@workspace/sdk-google-search-console';

import { addDays } from './calendar-dates.ts';
import { DatedAnalyticsStream } from './dated-analytics-stream.ts';
import {
  type InspectionOptions,
  InspectionStream,
} from './inspection-stream.ts';
import { RETENTION_MONTHS } from './search-analytics.ts';
import { SearchConsoleScan } from './search-console-scan.ts';
import type { SearchConsoleStream } from './search-console-stream.ts';
import { SearchAnalyticsCountriesStream } from './streams/search-analytics-countries-stream.ts';
import { SearchAnalyticsDailyStream } from './streams/search-analytics-daily-stream.ts';
import { SearchAnalyticsPagesStream } from './streams/search-analytics-pages-stream.ts';
import { SearchAnalyticsQueriesStream } from './streams/search-analytics-queries-stream.ts';
import { SitemapContentsStream } from './streams/sitemap-contents-stream.ts';
import { SitemapsStream } from './streams/sitemaps-stream.ts';
import { SitesStream } from './streams/sites-stream.ts';
import { UrlInspectionReferrersStream } from './streams/url-inspection-referrers-stream.ts';
import { UrlInspectionSitemapsStream } from './streams/url-inspection-sitemaps-stream.ts';
import { UrlInspectionStream } from './streams/url-inspection-stream.ts';

export type SearchAnalyticsType =
  'WEB' | 'IMAGE' | 'VIDEO' | 'NEWS' | 'DISCOVER' | 'GOOGLE_NEWS';

export type SearchConsoleOptions = {
  readonly requester: ConstructorParameters<typeof SearchConsoleApi>[0];
  readonly siteUrls: readonly string[];
  readonly searchTypes?: readonly SearchAnalyticsType[];
  readonly breakdownMonths?: number;
  // A URL is inspected again once its last inspection is this old.
  readonly inspectionRefreshHours?: number;
  readonly inspectionConcurrency?: number;
  // How many streams read at once; their API calls overlap.
  readonly streamConcurrency?: number;
  readonly pollIntervalMs?: number;
};

// The longest delay a Node timer holds; a longer one fires at once, so a
// longer sleep wakes early and the watch checks its due times again.
const TIMER_MAX = 2 ** 31 - 1;

// Days of daily totals the change probe compares.
const PROBE_DAYS = 28;

const SEARCH_TYPES = [
  'WEB',
  'IMAGE',
  'VIDEO',
  'NEWS',
  'DISCOVER',
  'GOOGLE_NEWS',
] as const satisfies readonly SearchAnalyticsType[];

export class SearchConsoleSource extends Source<SearchConsoleScan> {
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
  protected override readonly concurrency: number;
  // How each stream reads, by the stream it reads.
  readonly #readers: ReadonlyMap<Stream, SearchConsoleStream>;
  // When each inspection stream next has a URL due, per property, learned
  // from the checkpoints its extractions received; observe() sleeps on it.
  readonly #dueAt = new Map<string, number>();
  // Wakes a sleeping observe() whenever an extraction learns a due time, which
  // can be sooner than the one it went to sleep on.
  readonly #dueLearned = new EventTarget();

  constructor(options: SearchConsoleOptions) {
    super();
    const {
      siteUrls,
      searchTypes = SEARCH_TYPES,
      breakdownMonths = 3,
      inspectionRefreshHours = 24,
      inspectionConcurrency = 16,
      streamConcurrency = 4,
      pollIntervalMs = 6 * 60 * 60 * 1000,
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
    if (!Number.isSafeInteger(streamConcurrency) || streamConcurrency < 1)
      throw new TypeError(
        'streamConcurrency must be a whole number of at least one',
      );
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1)
      throw new TypeError(
        'pollIntervalMs must be a whole number of milliseconds of at least one',
      );
    this.siteUrls = Object.freeze([...siteUrls]);
    this.searchTypes = Object.freeze([...searchTypes]);
    this.breakdownMonths = breakdownMonths;
    this.inspectionRefreshHours = inspectionRefreshHours;
    this.inspectionConcurrency = inspectionConcurrency;
    this.concurrency = streamConcurrency;
    this.pollIntervalMs = pollIntervalMs;
    // The report types change which rows exist, so they bind a checkpoint.
    // The window does not: it moves with the clock and state resumes it. Nor
    // do the properties: each is a partition with its own checkpoint.
    this.identity = `search-console:${this.searchTypes.join('+')}`;
    this.#api = new SearchConsoleApi(options.requester);
    const inspection: InspectionOptions = {
      refreshHours: inspectionRefreshHours,
      concurrency: inspectionConcurrency,
      due: (stream, siteUrl, at) => {
        this.#dueAt.set(`${stream}\0${siteUrl}`, at);
        this.#dueLearned.dispatchEvent(new Event('learned'));
      },
    };
    const readers = {
      sites: new SitesStream(),
      sitemaps: new SitemapsStream(),
      sitemapContents: new SitemapContentsStream(),
      searchAnalyticsDaily: new SearchAnalyticsDailyStream(this.searchTypes),
      searchAnalyticsQueries: new SearchAnalyticsQueriesStream(),
      searchAnalyticsPages: new SearchAnalyticsPagesStream(),
      searchAnalyticsCountries: new SearchAnalyticsCountriesStream(
        breakdownMonths,
      ),
      urlInspection: new UrlInspectionStream(inspection),
      urlInspectionSitemaps: new UrlInspectionSitemapsStream(inspection),
      urlInspectionReferrers: new UrlInspectionReferrersStream(inspection),
    };
    this.sites = readers.sites.stream;
    this.sitemaps = readers.sitemaps.stream;
    this.sitemapContents = readers.sitemapContents.stream;
    this.searchAnalyticsDaily = readers.searchAnalyticsDaily.stream;
    this.searchAnalyticsQueries = readers.searchAnalyticsQueries.stream;
    this.searchAnalyticsPages = readers.searchAnalyticsPages.stream;
    this.searchAnalyticsCountries = readers.searchAnalyticsCountries.stream;
    this.urlInspection = readers.urlInspection.stream;
    this.urlInspectionSitemaps = readers.urlInspectionSitemaps.stream;
    this.urlInspectionReferrers = readers.urlInspectionReferrers.stream;
    this.#readers = new Map(
      Object.values(readers).map((reader) => [reader.stream, reader]),
    );
    this.catalog = new Catalog([...this.#readers.keys()]);
    Object.freeze(this);
  }

  protected override partitions(): readonly Partition[] {
    return this.siteUrls.map((siteUrl) => ({ siteUrl }));
  }

  // Each read shares its calls to Google through one scan, and asks again.
  protected override async open(): Promise<SearchConsoleScan> {
    return new SearchConsoleScan(this.#api, this.searchTypes);
  }

  override coverage(stream: Stream): ExtractionCoverage {
    const reader = this.#reader(stream);
    if (reader instanceof SitesStream)
      return {
        description:
          'All properties the Google grant can read, excluding unverified users. Not restricted to the configured siteUrls used by the other streams.',
        selection: {},
      };
    if (reader instanceof SearchAnalyticsCountriesStream)
      return {
        description:
          'Configured siteUrls, WEB country/device breakdown over breakdownMonths before the read date through that date, inclusive, in Pacific Time. The complete trailing window is read each pass. Google may withhold rows; success is not proof of all traffic.',
        selection: {
          siteUrls: this.siteUrls,
          searchTypes: ['WEB'],
          breakdownMonths: this.breakdownMonths,
          timeZone: 'America/Los_Angeles',
        },
      };
    if (reader instanceof DatedAnalyticsStream)
      return {
        description:
          'Configured siteUrls and searchTypes. Initial daily extraction requests sixteen months through the read date, inclusive, in Pacific Time; subsequent incremental passes resume each property checkpoint and reread unsettled days. The configured history policy is not the actual resumed request interval or observed row dates. Google may withhold breakdown rows; success does not make them authoritative totals.',
        selection: {
          siteUrls: this.siteUrls,
          searchTypes: reader.searchTypes,
          initialHistoryMonths: RETENTION_MONTHS,
          timeZone: 'America/Los_Angeles',
        },
      };
    if (reader instanceof InspectionStream)
      return {
        description:
          'Configured siteUrls. URLs discovered from sitemaps and sixteen months of search analytics; inspect new or due URLs according to inspectionRefreshHours until none remain or the daily quota is exhausted. A successful quota-limited pass can leave due URLs pending until Pacific midnight. Not all site URLs can be discovered. Prior inspections remain stored; this pass does not reinspect every stored URL.',
        selection: {
          siteUrls: this.siteUrls,
          searchTypes: this.searchTypes,
          inspectionRefreshHours: this.inspectionRefreshHours,
        },
      };
    // sitemaps and sitemapContents
    return {
      description:
        'Sitemaps or sitemap content counts returned for each configured siteUrl. No date filter. Sitemap metadata can load even if downloading its URL listing fails; consult readError in raw metadata for that availability.',
      selection: { siteUrls: this.siteUrls },
    };
  }

  override async currentAsOf() {
    return null;
  }

  // Google refused the grant, will no longer refresh it, or the grant cannot
  // read the property, so only the user can fix it. A rate limit Google sends
  // as a 403 never gets here: the API turns it into a SearchConsoleQuotaError
  // once retries run out.
  override failureType(error: unknown): FailureType {
    const status = statusOf(error);
    return status === 401 ||
      status === 403 ||
      GoogleGrantRevokedError.matches(error)
      ? 'config'
      : 'system';
  }

  /**
   * Search Console publishes no change notification, so observation polls. A
   * tick reads two cheap probes, each waking only the streams whose data it
   * covers: the daily web totals wake the analytics streams when the settled
   * boundary moved or a day's totals changed, and the property list with
   * each property's sitemap list wakes the listing streams when either
   * changed. Inspections follow neither: the inspection streams wake when
   * their next URL falls due, a time this source learned from the
   * checkpoints its own extractions received.
   */
  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    const inspections = streams.filter(
      (stream) => this.#reader(stream) instanceof InspectionStream,
    );
    const analytics = streams.filter((stream) => {
      const reader = this.#reader(stream);
      return (
        reader instanceof DatedAnalyticsStream ||
        reader instanceof SearchAnalyticsCountriesStream
      );
    });
    const listings = streams.filter(
      (stream) => !inspections.includes(stream) && !analytics.includes(stream),
    );
    const probes = [];
    for (const [woken, fingerprint] of [
      [analytics, () => this.#totals(signal)],
      [listings, () => this.#listings(signal)],
    ] as const)
      if (woken.length > 0)
        probes.push({ woken, fingerprint, seen: await fingerprint() });
    // The first check wakes every stream, the inspection streams included.
    let woke = Date.now();
    yield streams;
    let probeAt = Date.now() + this.pollIntervalMs;
    while (!signal.aborted) {
      // A due time that no extraction moved past the last wake, because that
      // extraction failed or has not run, is checked again at the next poll.
      const due = this.#nextDue(inspections);
      const inspectAt = due > woke ? due : woke + this.pollIntervalMs;
      const wake = Math.min(
        probes.length > 0 ? probeAt : Number.POSITIVE_INFINITY,
        inspections.length > 0 ? inspectAt : Number.POSITIVE_INFINITY,
        Date.now() + this.pollIntervalMs,
      );
      await this.#sleep(wake, signal);
      const changed: Stream[] = [];
      if (probes.length > 0 && Date.now() >= probeAt) {
        probeAt = Date.now() + this.pollIntervalMs;
        for (const probe of probes) {
          const current = await probe.fingerprint();
          if (current !== probe.seen) {
            probe.seen = current;
            changed.push(...probe.woken);
          }
        }
      }
      if (inspections.length > 0 && Date.now() >= inspectAt) {
        woke = Date.now();
        changed.push(...inspections);
      }
      if (changed.length > 0) yield changed;
    }
  }

  // Sleeps until wake, or until an extraction learns a due time.
  async #sleep(wake: number, signal: AbortSignal): Promise<void> {
    const learned = new AbortController();
    this.#dueLearned.addEventListener('learned', () => learned.abort(), {
      signal: learned.signal,
    });
    try {
      await sleep(
        Math.min(Math.max(0, wake - Date.now()), TIMER_MAX),
        undefined,
        {
          signal: AbortSignal.any([signal, learned.signal]),
        },
      );
    } catch (error) {
      if (signal.aborted || !learned.signal.aborted) throw error;
    } finally {
      learned.abort();
    }
  }

  // A due time no extraction has learned yet counts as due.
  #nextDue(streams: readonly Stream[]): number {
    let due = Number.POSITIVE_INFINITY;
    for (const stream of streams)
      for (const siteUrl of this.siteUrls)
        due = Math.min(
          due,
          this.#dueAt.get(`${stream.name}\0${siteUrl}`) ??
            Number.NEGATIVE_INFINITY,
        );
    return due;
  }

  protected override extract(
    configuration: CopyConfiguration,
    state: unknown,
    partition: Partition | null,
    scan: SearchConsoleScan,
    signal: AbortSignal | undefined,
  ): AsyncIterable<SourceMessage> {
    return this.#reader(configuration.stream).extract(
      configuration,
      state,
      partition,
      scan,
      signal,
    );
  }

  #reader(stream: Stream): SearchConsoleStream {
    const reader = this.#readers.get(stream);
    if (reader === undefined)
      throw new TypeError(`Search Console has no stream ${stream.name}`);
    return reader;
  }

  // Each property's daily web totals; a change in any of them wakes the
  // analytics streams.
  async #totals(signal: AbortSignal): Promise<string> {
    const totals = [];
    for (const siteUrl of this.siteUrls)
      totals.push(
        await this.#probe(signal, async () => {
          const endDate = today(new Date());
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
          return {
            firstIncompleteDate: page.firstIncompleteDate,
            rows: page.rows.map((row) => [
              row.keys[0],
              row.clicks,
              row.impressions,
            ]),
          };
        }),
      );
    return JSON.stringify(totals);
  }

  // The properties the grant lists and each property's sitemaps, as Google
  // returns them; a change in any of them wakes the listing streams.
  async #listings(signal: AbortSignal): Promise<string> {
    const lists = [
      await this.#probe(signal, () => this.#api.sites({ signal })),
    ];
    for (const siteUrl of this.siteUrls)
      lists.push(
        await this.#probe(signal, () =>
          this.#api.sitemaps(siteUrl, { signal }),
        ),
      );
    return JSON.stringify(lists);
  }

  // A call that fails is part of the fingerprint, not the end of watching:
  // when it starts or stops failing, the extraction that follows reports it
  // or loads it, while the other calls keep being watched.
  async #probe(
    signal: AbortSignal,
    call: () => Promise<unknown>,
  ): Promise<unknown> {
    signal.throwIfAborted();
    try {
      return await call();
    } catch (error) {
      if (signal.aborted) throw error;
      return { failed: messageOf(error) };
    }
  }
}
