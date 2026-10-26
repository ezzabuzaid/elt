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
import { type Finding, Reader, type Visit, isHtml } from './reader.ts';
import { httpUrl, webUrl } from './web-url.ts';

// candidate: a possible feed, read only if Feedscout validates it.
// guess: /sitemap.xml, read only if it turns out to be a listing.
const noteSchema = z.object({
  kind: z.enum(['robots', 'listing', 'candidate', 'guess']),
});
type Note = z.infer<typeof noteSchema>;

// listed: the starting page declared a listing, or one was read; both happen before robots.txt.
const stateSchema = z.object({ listed: z.boolean() });
type State = z.infer<typeof stateSchema>;

function document(
  url: string,
  note: Note,
  tolerate: readonly number[] | 'any',
  linked: boolean,
): Finding<Note> {
  return { url, lastModified: null, page: false, linked, tolerate, note };
}

/** Published lists of pages: robots.txt, sitemaps and feeds, with their pagination. */
export class ListingReader extends Reader<Note, State> {
  readonly notes = noteSchema;
  readonly states = stateSchema;

  open(): State {
    return { listed: false };
  }

  wants() {
    return false;
  }

  async read(
    { response, headers, type, request, note }: Visit<Note>,
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
          document(webUrl(url, response.url), { kind: 'listing' }, [], false),
        );
      if (state.listed) return [];
      return [
        document(
          new URL('/sitemap.xml', response.url).href,
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
      state.listed = true;
      return [
        ...listing.pages.map((page) => ({
          url: webUrl(page.url, response.url),
          lastModified: page.lastModified,
          page: true,
          linked: false,
          tolerate: [],
          note: null,
        })),
        ...[
          ...listing.sitemaps,
          ...discoverUrisFromHeaders(headers, {
            linkSelectors: paginationLinks,
          }),
        ].map((url) =>
          document(webUrl(url, response.url), { kind: 'listing' }, [], false),
        ),
      ];
    }
    if (response.statusCode !== 200 || !isHtml(type)) return [];
    const text = decodeSitemap(response.rawBody);
    const declared = readDeclarations(text, response.url, headers);
    const feed = (url: string, kind: 'listing' | 'candidate') =>
      document(
        url,
        { kind },
        kind === 'candidate' ? 'any' : [],
        !request.start,
      );
    if (!request.start) {
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
    if (declared.some(({ kind }) => kind === 'listing')) state.listed = true;
    return [
      ...declared.map(({ url, kind }) => feed(url, kind)),
      document(
        new URL('/robots.txt', response.url).href,
        { kind: 'robots' },
        [404, 410],
        false,
      ),
    ];
  }
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
