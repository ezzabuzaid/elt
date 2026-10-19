import { ClosedWorld } from '@zukhruf/snapshot-differential';

import {
  type CopyConfiguration,
  type Partition,
  type SourceMessage,
  diffSnapshot,
  isCalendarDate,
  validateRecords,
} from '@workspace/elt';
import {
  readSearchAnalytics,
  today,
} from '@workspace/sdk-google-search-console';

import { addDays, earlier, subMonths } from './calendar-dates.ts';
import { RETENTION_MONTHS, analyticsRecords } from './search-analytics.ts';
import type { SearchConsoleScan } from './search-console-scan.ts';
import type { SearchAnalyticsType } from './search-console-source.ts';
import {
  SearchConsoleStream,
  type StreamDefinition,
} from './search-console-stream.ts';

/**
 * A grain carrying the date dimension: it resumes on the date and diffs the
 * days it reads again. The daily totals repeat per report type and carry it
 * as data; the breakdowns are web-only, because Google anonymizes rare rows
 * and a wider grain loses more of the property's real traffic.
 */
export abstract class DatedAnalyticsStream extends SearchConsoleStream {
  // The report types each read requests, one request each.
  abstract readonly searchTypes: readonly SearchAnalyticsType[];
  // The dimensions each request groups by, date first.
  protected abstract readonly dimensions: readonly string[];

  constructor(definition: StreamDefinition) {
    super(definition, ['full_refresh', 'incremental']);
  }

  async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    partition: Partition | null,
    scan: SearchConsoleScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const siteUrl = this.siteUrl(partition);
    const endDate = today(new Date());
    const saved = this.#checkpoint(state);
    const startDate =
      saved === null
        ? subMonths(endDate, RETENTION_MONTHS)
        : earlier(saved.date, endDate);

    const rows: Record<string, unknown>[] = [];
    // The last settled day across the report types read.
    let settled = endDate;
    for (const type of this.searchTypes) {
      const page = await readSearchAnalytics(
        scan.api,
        siteUrl,
        {
          dataState: 'ALL',
          dimensions: [...this.dimensions],
          endDate,
          startDate,
          type,
        },
        { signal },
      );
      const { firstIncompleteDate } = page;
      rows.push(
        ...analyticsRecords(siteUrl, this.dimensions, page.rows, (row) => ({
          ...this.reportFields(type),
          settled:
            firstIncompleteDate === undefined ||
            String(row.date) < firstIncompleteDate,
        })),
      );
      // Report types settle independently, so the checkpoint keeps the
      // earliest boundary and re-reads the rest next run.
      if (firstIncompleteDate !== undefined)
        settled = earlier(settled, addDays(firstIncompleteDate, -1));
    }
    // Google may still restate every day from the next read's first, so the
    // snapshot keeps those days: a row a re-read no longer returns is deleted,
    // and the days before stay as loaded.
    for await (const message of diffSnapshot(
      configuration,
      validateRecords(this.stream, rows, 'Search Console'),
      saved === null ? null : saved.diff,
      {
        policy: new ClosedWorld(),
        rereads: (record) => String(record.date) >= settled,
      },
    ))
      yield 'type' in message && message.type === 'STATE'
        ? { ...message, state: { date: settled, diff: message.state } }
        : message;
  }

  // What a row carries for the report type it came from, beside its
  // dimensions and metrics.
  protected reportFields(_type: SearchAnalyticsType): Record<string, unknown> {
    return {};
  }

  // The checkpoint this stream wrote for a property, or null before its
  // first: the day the next read starts from, the last settled one, and the
  // diff's state for the days from it.
  #checkpoint(
    state: unknown,
  ): { readonly date: string; readonly diff: unknown } | null {
    if (state === null) return null;
    if (
      typeof state === 'object' &&
      'date' in state &&
      'diff' in state &&
      isCalendarDate(state.date)
    )
      return { date: state.date, diff: state.diff };
    throw new TypeError(
      `Search Console stream ${this.stream.name} has a checkpoint it did not write`,
    );
  }
}
