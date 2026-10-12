import type { SearchAnalyticsRow } from '@workspace/sdk-google-search-console';

import { searchConsoleFields } from './search-console-stream.ts';

const { ordinal, metric, nullableMetric, date, boolean } = searchConsoleFields;

// Search Console anonymizes rare queries, and the loss compounds with every
// added dimension, so a wide grain cannot reconstruct site totals. Each grain
// is its own stream: the daily totals stay authoritative while the breakdowns
// stay comparable only within themselves.

// Search Console keeps the last sixteen months of performance data.
export const RETENTION_MONTHS = 16;

export const dayField = {
  ...date,
  description:
    'The calendar day in Pacific Time, as Search Console reports it. It is not a UTC day.',
};

export const settledField = {
  ...boolean,
  description:
    'False while Google can still restate the day, usually the last two or three days; the next incremental read reads the day again. Compare settled days only.',
};

// Every analytics row's measures, as Google reports them.
export const metricFields = {
  clicks: {
    ...ordinal,
    description:
      'Clicks from search results to the property. Additive: sum them over any rows. The click-through rate over rows is sum(clicks)::float / nullif(sum(impressions), 0).',
  },
  impressions: {
    ...ordinal,
    description:
      'Times a search result showed the property. Additive: sum them over any rows.',
  },
  ctr: {
    ...metric,
    description:
      'The click-through rate of this row alone, from 0 to 1. Do not average it over rows: use sum(clicks)::float / nullif(sum(impressions), 0).',
  },
  position: {
    ...nullableMetric,
    description:
      'The average rank of this row in search results; 1 is the top result. NULL for Discover and Google News, which do not rank. Do not average it over rows: use sum(position * impressions) / nullif(sum(impressions) FILTER (WHERE position IS NOT NULL), 0).',
  },
};

/**
 * Each row as a record of its property: `keys` in a returned row matches the
 * requested dimensions positionally, so each dimension is a field named after
 * it, followed by what `fields` adds for the row and the metrics.
 */
export function analyticsRecords(
  siteUrl: string,
  dimensions: readonly string[],
  rows: readonly SearchAnalyticsRow[],
  fields: (keyed: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown>[] {
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
        ...fields(keyed),
        clicks: row.clicks,
        ctr: row.ctr,
        impressions: row.impressions,
        position: row.position,
      },
    ];
  });
}
