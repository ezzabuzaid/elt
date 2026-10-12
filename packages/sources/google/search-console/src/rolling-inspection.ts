import type { UrlInspection } from '@workspace/sdk-google-search-console';

// Where a URL was discovered for inspection.
export type Discovery = { readonly sitemap: boolean; readonly search: boolean };

// Every URL a property can be inspected for, and whether each sitemap the
// property lists was read: a sitemap that could not be read may still list a
// URL missing from the others, so that URL is not gone.
export type Universe = {
  readonly urls: ReadonlyMap<string, Discovery>;
  readonly complete: boolean;
};

// Per URL: when the stream last loaded its inspection and how many rows that
// inspection produced (one for urlInspection, the array length for the
// sitemap and referrer streams), so shrunk arrays and vanished URLs can be
// deleted without reading the destination.
export type Inspected = { readonly at: string; readonly rows: number };

/**
 * What one run of one inspection stream does for a property: reuse an
 * inspection another stream already made this read, call the API only for
 * URLs never inspected or older than the refresh age (never-inspected first,
 * then stalest), and delete URLs that left a complete universe.
 */
export function planInspections({
  saved,
  universe,
  cached,
  now,
  refreshMs,
}: {
  saved: ReadonlyMap<string, Inspected>;
  universe: Universe;
  cached: ReadonlyMap<string, UrlInspection>;
  now: number;
  refreshMs: number;
}): {
  reuse: UrlInspection[];
  due: string[];
  gone: [string, Inspected][];
  nextDue: number;
} {
  const reuse: UrlInspection[] = [];
  const due: { url: string; at: number }[] = [];
  let nextDue = Number.POSITIVE_INFINITY;
  for (const url of universe.urls.keys()) {
    const seen = saved.get(url)?.at;
    const inspection = cached.get(url);
    if (
      inspection !== undefined &&
      (seen === undefined || inspection.inspectedAt > seen)
    ) {
      reuse.push(inspection);
      nextDue = Math.min(
        nextDue,
        Date.parse(inspection.inspectedAt) + refreshMs,
      );
      continue;
    }
    const at = seen === undefined ? Number.NEGATIVE_INFINITY : Date.parse(seen);
    if (now - at < refreshMs) {
      nextDue = Math.min(nextDue, at + refreshMs);
      continue;
    }
    due.push({ url, at });
  }
  due.sort((left, right) => {
    if (left.at !== right.at) return left.at - right.at;
    if (left.url < right.url) return -1;
    if (left.url > right.url) return 1;
    return 0;
  });
  return {
    reuse,
    due: due.map(({ url }) => url),
    gone: universe.complete
      ? [...saved]
          .filter(([url]) => !universe.urls.has(url))
          .sort(([left], [right]) => (left < right ? -1 : 1))
      : [],
    nextDue,
  };
}
