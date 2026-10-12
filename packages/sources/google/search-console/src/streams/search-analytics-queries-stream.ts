import { DatedAnalyticsStream } from '../dated-analytics-stream.ts';
import { dayField, metricFields, settledField } from '../search-analytics.ts';
import { searchConsoleFields, siteUrl } from '../search-console-stream.ts';

const properties = {
  siteUrl,
  date: dayField,
  query: {
    ...searchConsoleFields.id,
    description: 'The search query as users typed it.',
  },
  ...metricFields,
  settled: settledField,
};

export class SearchAnalyticsQueriesStream extends DatedAnalyticsStream {
  readonly searchTypes = ['WEB'] as const;
  protected readonly dimensions = ['date', 'query'];

  constructor() {
    super({
      name: 'searchAnalyticsQueries',
      description:
        'One record per property, Pacific Time day and search query, from web search. Google withholds rare queries, so these rows do not add up to searchAnalyticsDaily. Primary key siteUrl, date, query. A row that Google no longer returns for a day that a read gets again, from the last settled day on, is deleted; earlier days stay as loaded.',
      properties,
      primaryKey: ['siteUrl', 'date', 'query'],
      partitionKey: ['siteUrl'],
    });
  }
}
