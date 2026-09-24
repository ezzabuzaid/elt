import type { DeleteMessage, Stream } from 'elt';

import type { UrlInspection } from './url-inspection.ts';

// Where a URL was discovered for inspection.
export type Discovery = { readonly sitemap: boolean; readonly search: boolean };

// Per URL: when the stream last loaded its inspection and how many rows that
// inspection produced (one for urlInspection, the array length for the
// sitemap and referrer streams), so shrunk arrays and vanished URLs can be
// deleted without reading the destination.
export type Inspected = { readonly at: string; readonly rows: number };

// The checkpoint this stream writes for a property: the source's own STATE,
// so it is read as written.
export type InspectionState = {
  readonly inspected: Readonly<Record<string, Inspected>>;
};

export function readInspectionState(state: unknown): Map<string, Inspected> {
  return new Map(
    Object.entries((state as InspectionState | null)?.inspected ?? {}),
  );
}

/**
 * What one run of one inspection stream does for a property: reuse an
 * inspection another stream already made this run, call the API only for
 * URLs never inspected or older than the refresh age (never-inspected first,
 * then stalest), and delete URLs that left the universe.
 */
export function planInspections({
  saved,
  universe,
  cached,
  now,
  refreshMs,
}: {
  saved: ReadonlyMap<string, Inspected>;
  universe: ReadonlyMap<string, Discovery>;
  cached: ReadonlyMap<string, UrlInspection>;
  now: number;
  refreshMs: number;
}): {
  reuse: UrlInspection[];
  due: string[];
  gone: string[];
  nextDue: number;
} {
  const reuse: UrlInspection[] = [];
  const due: { url: string; at: number }[] = [];
  let nextDue = Number.POSITIVE_INFINITY;
  for (const url of universe.keys()) {
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
  due.sort((left, right) =>
    left.at !== right.at
      ? left.at - right.at
      : left.url < right.url
        ? -1
        : left.url > right.url
          ? 1
          : 0,
  );
  return {
    reuse,
    due: due.map(({ url }) => url),
    gone: [...saved.keys()].filter((url) => !universe.has(url)).sort(),
    nextDue,
  };
}

// Deletions for every row a URL held in this stream, keyed like its rows.
export function deletions(
  stream: Stream,
  siteUrl: string,
  inspectionUrl: string,
  from: number,
  to: number,
): DeleteMessage[] {
  if (stream.name === 'urlInspection')
    return from === 0 && to > 0
      ? [
          {
            type: 'DELETE',
            stream: stream.name,
            key: { siteUrl, inspectionUrl },
          },
        ]
      : [];
  return Array.from({ length: Math.max(0, to - from) }, (_, offset) => ({
    type: 'DELETE' as const,
    stream: stream.name,
    key: { siteUrl, inspectionUrl, position: from + offset },
  }));
}
