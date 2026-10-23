import { Mutex } from '@zukhruf/mutex';
import { MemoryStore } from '@zukhruf/mutex/memory';

import {
  type SearchConsoleApi,
  type UrlInspection,
  pageUrl,
  readSearchAnalytics,
  readSitemaps,
  today,
  underProperty,
} from '@workspace/sdk-google-search-console';

import { subMonths } from './calendar-dates.ts';
import type { Discovery, Universe } from './rolling-inspection.ts';
import { RETENTION_MONTHS } from './search-analytics.ts';
import type { SearchAnalyticsType } from './search-console-source.ts';

// The sitemaps sitemaps.list returns for a property.
type Sitemaps = NonNullable<
  Awaited<ReturnType<SearchConsoleApi['sitemaps']>>['sitemap']
>;

type SitemapReads = Awaited<ReturnType<typeof readSitemaps>>;

// What the inspection streams of one property share in one read: the
// inspections made, so they make one API call per URL, and when Google takes
// inspections again after refusing one for the daily quota, the latest any
// of them knows; before any refusal that time has passed.
export type PropertyInspections = {
  readonly made: Map<string, UrlInspection>;
  quotaResetAt: number;
};

/**
 * One read's shared work with Google, per property: the streams of the read
 * ask it, and the first to ask makes the call the others reuse, its failure
 * included. A later read asks Google again. Every stream of one read gets the
 * run's one signal, so the call carries the signal of whichever asked first.
 */
export class SearchConsoleScan implements AsyncDisposable {
  readonly api: SearchConsoleApi;
  readonly #searchTypes: readonly SearchAnalyticsType[];
  readonly #sitemaps = new Map<string, Promise<Sitemaps>>();
  readonly #sitemapReads = new Map<string, Promise<SitemapReads>>();
  readonly #discovered = new Map<string, Promise<Universe>>();
  readonly #inspections = new Map<string, PropertyInspections>();
  // Inspection streams read at once take turns per property to plan and
  // inspect, so each sees what the one before it inspected and no URL is
  // inspected twice; different properties never wait on each other.
  readonly #inspecting = new Mutex(new MemoryStore());

  constructor(
    api: SearchConsoleApi,
    searchTypes: readonly SearchAnalyticsType[],
  ) {
    this.api = api;
    this.#searchTypes = searchTypes;
  }

  // The sitemaps the property lists.
  sitemaps(
    siteUrl: string,
    signal: AbortSignal | undefined,
  ): Promise<Sitemaps> {
    return this.#sitemaps.getOrInsertComputed(siteUrl, async () => {
      const { sitemap = [] } = await this.api.sitemaps(siteUrl, { signal });
      return sitemap;
    });
  }

  // Each sitemap the property lists, downloaded: its page URLs, or why it
  // could not be read.
  sitemapReads(
    siteUrl: string,
    signal: AbortSignal | undefined,
  ): Promise<SitemapReads> {
    return this.#sitemapReads.getOrInsertComputed(siteUrl, async () =>
      readSitemaps(
        (await this.sitemaps(siteUrl, signal)).map(({ path }) => path),
        signal,
      ),
    );
  }

  /**
   * Every URL the property can be inspected for: each URL its sitemaps list
   * and each page its search analytics history shows, fragments stripped and
   * limited to the property.
   */
  universe(
    siteUrl: string,
    signal: AbortSignal | undefined,
  ): Promise<Universe> {
    return this.#discovered.getOrInsertComputed(siteUrl, () =>
      this.#discover(siteUrl, signal),
    );
  }

  // Runs work alone among the inspection streams of the property, with what
  // they share so far in this read.
  turn<T>(
    siteUrl: string,
    work: (shared: PropertyInspections) => Promise<T>,
  ): Promise<T> {
    return this.#inspecting.acquire(siteUrl, () =>
      work(
        this.#inspections.getOrInsertComputed(siteUrl, () => ({
          made: new Map(),
          quotaResetAt: Number.NEGATIVE_INFINITY,
        })),
      ),
    );
  }

  async #discover(
    siteUrl: string,
    signal: AbortSignal | undefined,
  ): Promise<Universe> {
    // An unreadable sitemap is reported on the sitemaps stream; inspection
    // still covers every URL the other sources show.
    const reads = [...(await this.sitemapReads(siteUrl, signal)).values()];
    const sitemapUrls = reads.flatMap((read) => read.urls ?? []);
    const searchUrls = new Set<string>();
    const endDate = today(new Date());
    for (const type of this.#searchTypes) {
      const page = await readSearchAnalytics(
        this.api,
        siteUrl,
        {
          dataState: 'ALL',
          dimensions: ['page'],
          endDate,
          startDate: subMonths(endDate, RETENTION_MONTHS),
          type,
        },
        { signal },
      );
      for (const row of page.rows)
        if (row.keys[0] !== undefined) searchUrls.add(row.keys[0]);
    }
    const urls = new Map<string, Discovery>();
    const add = (raw: string, from: 'sitemap' | 'search') => {
      const url = pageUrl(raw);
      if (url === undefined || !underProperty(siteUrl, url)) return;
      const known = urls.get(url) ?? { sitemap: false, search: false };
      urls.set(url, { ...known, [from]: true });
    };
    for (const url of sitemapUrls) add(url, 'sitemap');
    for (const url of searchUrls) add(url, 'search');
    return { urls, complete: reads.every((read) => read.error === null) };
  }

  // Everything is asked of Google while the read runs; nothing stays open.
  async [Symbol.asyncDispose](): Promise<void> {}
}
