import {
  type CopyConfiguration,
  type DeleteMessage,
  type KeyValue,
  type Partition,
  type SourceMessage,
  isTimestamp,
} from '@workspace/elt';
import {
  type UrlInspection,
  inspectUrls,
  nextPacificMidnight,
} from '@workspace/sdk-google-search-console';

import {
  type Discovery,
  type Inspected,
  planInspections,
} from './rolling-inspection.ts';
import type { SearchConsoleScan } from './search-console-scan.ts';
import {
  SearchConsoleStream,
  type StreamDefinition,
  searchConsoleFields,
} from './search-console-stream.ts';

export const inspectionUrlField = {
  ...searchConsoleFields.id,
  description:
    'The inspected page URL, without a fragment: a URL a sitemap of the property lists, or a page its search analytics show.',
};

export type InspectionOptions = {
  // A URL is inspected again once its last inspection is this old.
  readonly refreshHours: number;
  readonly concurrency: number;
  // Tells the source that watches inspections when this stream next has a
  // URL due at a property.
  readonly due: (stream: string, siteUrl: string, at: number) => void;
};

// The checkpoint an inspection stream writes for a property: per URL, and
// when Google takes the property's inspections again after refusing one for
// the daily quota, a time that has passed before any refusal.
type Saved = {
  readonly inspected: Map<string, Inspected>;
  readonly quotaResetAt: number;
};

/**
 * One rolling pass of one inspection stream over one property: delete URLs
 * that left the universe, reuse inspections another stream already made,
 * and inspect never-inspected then stalest URLs until none is due or the
 * daily quota runs out. Progress is kept per URL in the stream's state, with
 * when the quota resets, so a run waits for it. Each run refreshes only the
 * URLs that fell due, so the stream is incremental only.
 */
export abstract class InspectionStream extends SearchConsoleStream {
  readonly #refreshMs: number;
  readonly #concurrency: number;
  readonly #due: InspectionOptions['due'];

  constructor(
    definition: StreamDefinition,
    { refreshHours, concurrency, due }: InspectionOptions,
  ) {
    super(definition, ['incremental']);
    this.#refreshMs = refreshHours * 60 * 60 * 1000;
    this.#concurrency = concurrency;
    this.#due = due;
  }

  async *extract(
    _configuration: CopyConfiguration,
    state: unknown,
    partition: Partition | null,
    scan: SearchConsoleScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const siteUrl = this.siteUrl(partition);
    const saved = this.#saved(state);
    const universe = await scan.universe(siteUrl, signal);
    const { gone, inspections, quotaResetAt } = await scan.turn(
      siteUrl,
      async (shared) => {
        // This stream's checkpoint can know of a refusal the read has not met.
        shared.quotaResetAt = Math.max(shared.quotaResetAt, saved.quotaResetAt);
        const plan = planInspections({
          saved: saved.inspected,
          universe,
          cached: shared.made,
          now: Date.now(),
          refreshMs: this.#refreshMs,
        });
        const inspections = [...plan.reuse];
        let nextDue = plan.nextDue;
        if (plan.due.length > 0) {
          if (Date.now() < shared.quotaResetAt)
            nextDue = Math.min(nextDue, shared.quotaResetAt);
          else {
            const { inspections: made, exhausted } = await inspectUrls(
              scan.api,
              siteUrl,
              plan.due,
              { concurrency: this.#concurrency, signal },
            );
            for (const inspection of made) {
              shared.made.set(inspection.inspectionUrl, inspection);
              nextDue = Math.min(
                nextDue,
                Date.parse(inspection.inspectedAt) + this.#refreshMs,
              );
            }
            inspections.push(...made);
            if (exhausted) {
              shared.quotaResetAt = nextPacificMidnight(new Date()).getTime();
              nextDue = Math.min(nextDue, shared.quotaResetAt);
            }
          }
        }
        this.#due(this.stream.name, siteUrl, nextDue);
        return {
          gone: plan.gone,
          inspections,
          quotaResetAt: shared.quotaResetAt,
        };
      },
    );

    const next = new Map(saved.inspected);
    for (const [url, { rows }] of gone) {
      yield* this.#deletions(siteUrl, url, 0, rows);
      next.delete(url);
    }
    inspections.sort((left, right) =>
      left.inspectionUrl < right.inspectionUrl ? -1 : 1,
    );
    for (const inspection of inspections) {
      const discovery = universe.urls.get(inspection.inspectionUrl);
      if (discovery === undefined)
        throw new TypeError(
          `Search Console inspected ${inspection.inspectionUrl}, which ${siteUrl} did not list`,
        );
      const rows = this.rows(siteUrl, inspection, discovery);
      yield* this.records(rows);
      yield* this.#deletions(
        siteUrl,
        inspection.inspectionUrl,
        rows.length,
        saved.inspected.get(inspection.inspectionUrl)?.rows ?? 0,
      );
      next.set(inspection.inspectionUrl, {
        at: inspection.inspectedAt,
        rows: rows.length,
      });
    }
    yield {
      type: 'STATE',
      stream: this.stream.name,
      state: {
        inspected: Object.fromEntries(
          [...next].sort(([left], [right]) => (left < right ? -1 : 1)),
        ),
        quotaResetAt:
          quotaResetAt > Date.now()
            ? new Date(quotaResetAt).toISOString()
            : null,
      },
    };
  }

  // The rows one inspection produces in this stream, numbered from 0.
  protected abstract rows(
    siteUrl: string,
    inspection: UrlInspection,
    discovery: Discovery,
  ): Record<string, unknown>[];

  // The primary key of the row a URL holds at a position: a URL's rows are
  // the entries of a list Google returns, keyed by their position in it.
  protected key(
    siteUrl: string,
    inspectionUrl: string,
    position: number,
  ): Readonly<Record<string, KeyValue>> {
    return { siteUrl, inspectionUrl, position };
  }

  // The checkpoint this stream wrote for a property, or nothing inspected and
  // no refusal before its first.
  #saved(state: unknown): Saved {
    if (state === null)
      return {
        inspected: new Map(),
        quotaResetAt: Number.NEGATIVE_INFINITY,
      };
    const invalid = () =>
      new TypeError(
        `Search Console stream ${this.stream.name} has a checkpoint it did not write`,
      );
    if (
      typeof state !== 'object' ||
      !('inspected' in state) ||
      !('quotaResetAt' in state) ||
      typeof state.inspected !== 'object' ||
      state.inspected === null ||
      Array.isArray(state.inspected) ||
      (state.quotaResetAt !== null && !isTimestamp(state.quotaResetAt))
    )
      throw invalid();
    return {
      inspected: new Map(
        Object.entries(state.inspected).map(
          ([url, entry]: [string, unknown]): [string, Inspected] => {
            if (
              typeof entry !== 'object' ||
              entry === null ||
              !('at' in entry) ||
              !('rows' in entry) ||
              !isTimestamp(entry.at) ||
              typeof entry.rows !== 'number' ||
              !Number.isSafeInteger(entry.rows) ||
              entry.rows < 0
            )
              throw invalid();
            return [url, { at: entry.at, rows: entry.rows }];
          },
        ),
      ),
      quotaResetAt:
        state.quotaResetAt === null
          ? Number.NEGATIVE_INFINITY
          : Date.parse(state.quotaResetAt),
    };
  }

  // Deletions for the rows a URL held from `from` up to `to`: those its
  // inspection no longer produces, so shrunk lists and vanished URLs are
  // deleted without reading the destination.
  *#deletions(
    siteUrl: string,
    inspectionUrl: string,
    from: number,
    to: number,
  ): Generator<DeleteMessage> {
    for (let position = from; position < to; position += 1)
      yield {
        type: 'DELETE',
        stream: this.stream.name,
        key: this.key(siteUrl, inspectionUrl, position),
      };
  }
}
