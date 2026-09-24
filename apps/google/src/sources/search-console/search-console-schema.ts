import { type FieldSchema, Stream, type SyncMode } from 'elt';

const text = { type: 'string' } as const;
const id = { ...text, minLength: 1 };
const nullableText = { type: ['string', 'null'] } as const;
const integer = { type: 'integer' } as const;
const ordinal = { ...integer, minimum: 0 };
const nullableOrdinal = { type: ['integer', 'null'], minimum: 0 } as const;
const boolean = { type: 'boolean' } as const;
const metric = { type: 'number', minimum: 0 } as const;
// Feed reports omit position entirely, including on zero-traffic rows, so a
// missing rank is unknown rather than the best possible rank.
const nullableMetric = { type: ['number', 'null'], minimum: 0 } as const;
const nullableTimestamp = { ...nullableText, format: 'date-time' } as const;
// Search Console reports a PST calendar date, not an instant.
const date = { ...id, format: 'date' } as const;

export const searchConsoleFields = {
  text,
  id,
  nullableText,
  integer,
  ordinal,
  nullableOrdinal,
  boolean,
  metric,
  nullableMetric,
  nullableTimestamp,
  date,
};

// Grouping dimensions the API accepts. `keys` in a returned row matches the
// requested order positionally, so the connector owns every column name.
export const searchAnalyticsDimensions = [
  'date',
  'query',
  'page',
  'country',
  'device',
  'searchAppearance',
] as const;

export type SearchAnalyticsDimension =
  (typeof searchAnalyticsDimensions)[number];

export const searchAnalyticsMetrics = {
  clicks: metric,
  impressions: metric,
  ctr: metric,
  position: nullableMetric,
} as const;

/**
 * Search Console anonymizes rare queries, and the loss compounds with every
 * added dimension, so a wide grain cannot reconstruct site totals. Each grain
 * is its own stream: the daily totals stay authoritative while the breakdowns
 * stay comparable only within themselves.
 */
export type SearchAnalyticsGrain =
  | 'searchAnalyticsDaily'
  | 'searchAnalyticsQueries'
  | 'searchAnalyticsPages'
  | 'searchAnalyticsCountries';

export type SearchAnalyticsGrainSpec = {
  readonly dimensions: readonly SearchAnalyticsDimension[];
  readonly key: readonly string[];
  readonly extra?: Readonly<Record<string, FieldSchema>>;
};

export const searchAnalyticsGrains: Readonly<
  Record<SearchAnalyticsGrain, SearchAnalyticsGrainSpec>
> = {
  searchAnalyticsDaily: {
    dimensions: ['date'],
    key: ['date', 'searchType'],
    extra: { searchType: id },
  },
  searchAnalyticsQueries: {
    dimensions: ['date', 'query'],
    key: ['date', 'query'],
  },
  searchAnalyticsPages: {
    dimensions: ['date', 'page'],
    key: ['date', 'page'],
  },
  searchAnalyticsCountries: {
    dimensions: ['country', 'device'],
    key: ['country', 'device'],
  },
};

export function searchAnalyticsFields(
  grain: SearchAnalyticsGrain,
): Record<string, FieldSchema> {
  const { dimensions, extra } = searchAnalyticsGrains[grain];
  return {
    ...Object.fromEntries(
      dimensions.map((dimension) => [
        dimension,
        dimension === 'date' ? date : id,
      ]),
    ),
    ...(extra ?? {}),
    ...searchAnalyticsMetrics,
  };
}

export const sitesFields = {
  siteUrl: id,
  permissionLevel: nullableText,
} satisfies Record<string, FieldSchema>;

export const sitemapsFields = {
  path: id,
  type: nullableText,
  lastSubmitted: nullableTimestamp,
  lastDownloaded: nullableTimestamp,
  isPending: boolean,
  isSitemapsIndex: boolean,
  warnings: ordinal,
  errors: ordinal,
} satisfies Record<string, FieldSchema>;

export const sitemapContentsFields = {
  sitemapPath: id,
  type: text,
  submitted: ordinal,
  indexed: nullableOrdinal,
} satisfies Record<string, FieldSchema>;

export const urlInspectionFields = {
  inspectionUrl: id,
  siteUrl: id,
  verdict: nullableText,
  coverageState: nullableText,
  robotsTxtState: nullableText,
  indexingState: nullableText,
  pageFetchState: nullableText,
  crawledAs: nullableText,
  googleCanonical: nullableText,
  userCanonical: nullableText,
  lastCrawlTime: nullableTimestamp,
  inspectionResultLink: nullableText,
  mobileUsabilityVerdict: nullableText,
  richResultsVerdict: nullableText,
  ampVerdict: nullableText,
} satisfies Record<string, FieldSchema>;

export const urlInspectionSitemapsFields = {
  inspectionUrl: id,
  position: ordinal,
  sitemap: text,
} satisfies Record<string, FieldSchema>;

export const urlInspectionReferrersFields = {
  inspectionUrl: id,
  position: ordinal,
  referringUrl: text,
} satisfies Record<string, FieldSchema>;

export function searchConsoleStream({
  name,
  fields,
  primaryKey,
  supportedSyncModes = ['full_refresh'],
  snapshot = false,
}: {
  name: string;
  fields: Record<string, FieldSchema>;
  primaryKey: readonly string[];
  supportedSyncModes?: readonly SyncMode[];
  // A complete list on every read: incremental copies diff it (diffSnapshot).
  snapshot?: boolean;
}): Stream {
  return new Stream({
    name,
    jsonSchema: {
      type: 'object',
      properties: fields,
      required: Object.keys(fields),
    },
    primaryKey,
    supportedSyncModes: snapshot
      ? ['full_refresh', 'incremental']
      : supportedSyncModes,
    ...(snapshot && { sourceDefinedCursor: true, emitsDeletes: true }),
  });
}
