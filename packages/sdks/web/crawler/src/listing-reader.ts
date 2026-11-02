import { RobotsTxtFile } from '@crawlee/utils';
import {
  anchorAttributes,
  anchorLabels,
  defaultExtractFn,
  defaultHeadersOptions,
  defaultHtmlOptions,
  linkSelectors,
} from 'feedscout/feeds';
import {
  discoverUrisFromHeaders,
  discoverUrisFromHtml,
} from 'feedscout/methods';
import { z } from 'zod';

import { decodeSitemap } from '@workspace/codec-sitemap';

import { paginationLinks, readListing } from './listing.ts';
import {
  type Finding,
  Reader,
  type RouteHow,
  type Visit,
  isHtml,
  pageText,
} from './reader.ts';
import { httpUrl, webUrl } from './web-url.ts';

// candidate: a possible feed, read only if Feedscout validates it.
// guess: /sitemap.xml, read only if it turns out to be a listing.
const noteSchema = z.object({
  kind: z.enum(['robots', 'listing', 'candidate', 'guess']),
});
type Note = z.infer<typeof noteSchema>;

// listed: each origin where an expanded page declared a listing, or a listing
// was read; both happen before the origin's robots.txt, which then gives no
// /sitemap.xml guess.
const stateSchema = z.object({ listed: z.array(z.string()) });
type State = z.infer<typeof stateSchema>;

function document(
  url: string,
  how: RouteHow,
  note: Note,
  tolerate: readonly number[] | 'any',
  linked: boolean,
): Finding<Note> {
  return {
    url,
    naming: { how, text: null },
    lastModified: null,
    published: null,
    localizedVersions: [],
    page: false,
    list: false,
    linked,
    tolerate,
    note,
    priority: 'listing',
  };
}

/** Published lists of pages: robots.txt, sitemaps and feeds, with their pagination. */
export class ListingReader extends Reader<Note, State> {
  readonly notes = noteSchema;
  readonly states = stateSchema;

  open(): State {
    return { listed: [] };
  }

  wants() {
    return false;
  }

  async read(
    { response, headers, type, request, note, revisitWithin }: Visit<Note>,
    state: State,
  ): Promise<readonly Finding<Note>[]> {
    if (note?.kind === 'robots') {
      const sitemaps = response.ok
        ? RobotsTxtFile.from(
            response.url,
            decodeSitemap(response.rawBody),
          ).getSitemaps({ enqueueStrategy: 'all' })
        : [];
      if (sitemaps.length > 0)
        return sitemaps.map((url) =>
          document(
            webUrl(url, response.url),
            'robots-sitemap',
            { kind: 'listing' },
            [],
            false,
          ),
        );
      if (state.listed.includes(new URL(response.url).origin)) return [];
      return [
        document(
          new URL('/sitemap.xml', response.url).href,
          'sitemap-guess',
          { kind: 'guess' },
          [404, 410],
          false,
        ),
      ];
    }
    if (note !== null || (request.start && !isHtml(type))) {
      // Failures reach a reader only when the finding tolerated them.
      if (!response.ok) return [];
      let listing;
      try {
        const text = decodeSitemap(response.rawBody);
        if (
          note?.kind === 'candidate' &&
          !(
            await defaultExtractFn({
              url: response.url,
              content: text,
              headers,
              status: response.statusCode,
            })
          ).isValid
        )
          return [];
        if (isHtml(type)) throw new Error('Expected a listing, received HTML');
        listing = readListing(text);
      } catch (error) {
        // A guess that is not a listing, such as a soft 404 page, is no error.
        if (note?.kind === 'guess') return [];
        throw error;
      }
      listed(state, response.url);
      // A feed rolls its oldest items off; visited again within half the time they cover, it loses none (#2936).
      if (listing.span !== null) revisitWithin(listing.span / 2);
      return [
        ...listing.pages.map((page) => ({
          url: webUrl(page.url, response.url),
          naming: listing.feed
            ? { how: 'feed-item' as const, text: page.title }
            : { how: 'sitemap-entry' as const, text: null },
          lastModified: page.lastModified,
          published: instant(page.published),
          // A copy that is not an HTTP(S) URL is a hint lost, not a listing that fails.
          localizedVersions: page.localizedVersions.flatMap(
            ({ language, url }) => {
              const resolved = httpUrl(url, response.url);
              return resolved === null ? [] : [{ language, url: resolved }];
            },
          ),
          page: true,
          list: false,
          linked: false,
          tolerate: [],
          note: null,
          priority: 'page' as const,
        })),
        // A child of a sitemap index is backfill: it shares downloads with
        // the pages and the other origins, as Heritrix gives the children
        // as outlinks, so one index cannot hold up the frontier.
        ...listing.sitemaps.map((url) => ({
          ...document(
            webUrl(url, response.url),
            'sitemap-index',
            { kind: 'listing' },
            [],
            false,
          ),
          priority: 'backfill' as const,
        })),
        ...[
          ...listing.pagination,
          ...discoverUrisFromHeaders(headers, {
            linkSelectors: paginationLinks,
          }),
        ].map((url) =>
          document(
            webUrl(url, response.url),
            'pagination',
            { kind: 'listing' },
            [],
            false,
          ),
        ),
      ];
    }
    if (response.statusCode !== 200 || !isHtml(type)) return [];
    const text = pageText(response);
    const declared = readDeclarations(text, response.url, headers);
    const feed = (url: string, kind: 'listing' | 'candidate') =>
      document(
        url,
        'declaration',
        { kind },
        kind === 'candidate' ? 'any' : [],
        request.expand === null,
      );
    // A page that the crawl does not expand gives only its declared listings;
    // a starting or one-step page also gives its origin's robots.txt, below.
    if (request.expand === null) {
      // A page reached by crawling needs an explicit declaration, or Feedscout's own hints, for a cross-origin feed.
      const origin = new URL(response.url).origin;
      const advertised = new Set(
        [
          ...discoverUrisFromHtml(text, {
            ...defaultHtmlOptions,
            baseUrl: response.url,
            anchorLabels: [],
            anchorAttributes: [],
          }),
          ...discoverUrisFromHeaders(headers, defaultHeadersOptions),
        ].flatMap((uri) => httpUrl(uri, response.url) ?? []),
      );
      return declared
        .filter(
          ({ url, kind }) =>
            kind === 'listing' ||
            new URL(url).origin === origin ||
            advertised.has(url),
        )
        .map(({ url, kind }) => feed(url, kind));
    }
    if (declared.some(({ kind }) => kind === 'listing'))
      listed(state, response.url);
    return [
      ...declared.map(({ url, kind }) => feed(url, kind)),
      document(
        new URL('/robots.txt', response.url).href,
        'robots',
        { kind: 'robots' },
        [404, 410],
        false,
      ),
    ];
  }
}

function listed(state: State, url: string) {
  const { origin } = new URL(url);
  if (!state.listed.includes(origin)) state.listed.push(origin);
}

// A date as Date reads it, RFC 822 from RSS or RFC 3339 from Atom and JSON Feed, in ISO 8601 UTC; null when it is not a date.
function instant(date: string | null) {
  const time = date === null ? Number.NaN : Date.parse(date);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function readDeclarations(html: string, url: string, headers: Headers) {
  const feeds: { url: string; kind: 'listing' | 'candidate' }[] = [];
  for (const { kind, selectors } of [
    {
      kind: 'listing',
      selectors: [
        ...linkSelectors.map((selector) =>
          selector.types === undefined
            ? selector
            : {
                ...selector,
                types: selector.types.filter(
                  (type) => type !== 'application/json',
                ),
              },
        ),
        { rel: 'sitemap' },
      ],
    },
    {
      kind: 'candidate',
      selectors: [{ rel: 'alternate', types: ['application/json'] }],
    },
  ] satisfies {
    kind: 'listing' | 'candidate';
    selectors: typeof linkSelectors;
  }[]) {
    for (const uri of [
      ...discoverUrisFromHtml(html, {
        baseUrl: url,
        linkSelectors: selectors,
        anchorUris: [],
        anchorIgnoredUris: [],
        anchorLabels:
          kind === 'candidate'
            ? anchorLabels.map(
                (label) => new RegExp(`\\b${RegExp.escape(label)}\\b`, 'i'),
              )
            : [],
        anchorAttributes: kind === 'candidate' ? anchorAttributes : [],
      }),
      ...discoverUrisFromHeaders(headers, {
        linkSelectors: selectors,
      }),
    ]) {
      const target = httpUrl(uri, url);
      if (target) feeds.push({ url: target, kind });
    }
  }
  return feeds;
}
