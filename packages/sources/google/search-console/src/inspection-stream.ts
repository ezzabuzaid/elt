import { Coverage } from '@zukhruf/snapshot-differential';

import {
  type CopyConfiguration,
  type Partition,
  type SourceMessage,
  diffSnapshot,
  isTimestamp,
  validateRecords,
} from '@workspace/elt';
import {
  type UrlInspection,
  inspectUrls,
  nextPacificMidnight,
} from '@workspace/sdk-google-search-console';

import { type Discovery, planInspections } from './rolling-inspection.ts';
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

// The checkpoint an inspection stream writes for a property: when each URL
// was last inspected; when Google takes the property's inspections again
// after refusing one for the daily quota, a time that has passed before any
// refusal; and the snapshot of the rows loaded so far.
type Saved = {
  readonly inspected: Map<string, string>;
  readonly quotaResetAt: number;
  readonly diff: unknown;
};

/**
 * One rolling pass of one inspection stream over one property: delete URLs
 * that left the universe, reuse inspections another stream already made,
 * and inspect never-inspected then stalest URLs until none is due or the
 * daily quota runs out. Progress is kept per URL in the stream's state, with
 * when the quota resets, so a run waits for it. Each run refreshes only the
 * URLs that fell due, so the stream is incremental only, and its snapshot
 * diff judges only the rows of the URLs the run inspected or found gone.
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
    for (const url of gone) next.delete(url);
    inspections.sort((left, right) =>
      left.inspectionUrl < right.inspectionUrl ? -1 : 1,
    );
    const rows: Record<string, unknown>[] = [];
    for (const inspection of inspections) {
      const discovery = universe.urls.get(inspection.inspectionUrl);
      if (discovery === undefined)
        throw new TypeError(
          `Search Console inspected ${inspection.inspectionUrl}, which ${siteUrl} did not list`,
        );
      rows.push(...this.rows(siteUrl, inspection, discovery));
      next.set(inspection.inspectionUrl, inspection.inspectedAt);
    }
    // A URL this run inspected lists all its rows, and a gone URL lists none;
    // every other URL keeps the rows its last inspection loaded.
    const judged: ReadonlySet<unknown> = new Set([
      ...gone,
      ...inspections.map(({ inspectionUrl }) => inspectionUrl),
    ]);
    for await (const message of diffSnapshot(
      this.stream,
      validateRecords(this.stream, rows, 'Search Console'),
      saved.diff,
      { policy: new Coverage(({ key }) => judged.has(key.inspectionUrl)) },
    ))
      if ('type' in message && message.type === 'STATE')
        yield {
          ...message,
          state: {
            inspected: Object.fromEntries(
              [...next].sort(([left], [right]) => (left < right ? -1 : 1)),
            ),
            quotaResetAt:
              quotaResetAt > Date.now()
                ? new Date(quotaResetAt).toISOString()
                : null,
            diff: message.state,
          },
        };
      else yield message;
  }

  // The rows one inspection produces in this stream, numbered from 0.
  protected abstract rows(
    siteUrl: string,
    inspection: UrlInspection,
    discovery: Discovery,
  ): Record<string, unknown>[];

  // The checkpoint this stream wrote for a property, or nothing inspected and
  // no refusal before its first.
  #saved(state: unknown): Saved {
    if (state === null)
      return {
        inspected: new Map(),
        quotaResetAt: Number.NEGATIVE_INFINITY,
        diff: null,
      };
    const invalid = () =>
      new TypeError(
        `Search Console stream ${this.stream.name} has a checkpoint it did not write`,
      );
    if (
      typeof state !== 'object' ||
      !('inspected' in state) ||
      !('quotaResetAt' in state) ||
      !('diff' in state) ||
      typeof state.inspected !== 'object' ||
      state.inspected === null ||
      Array.isArray(state.inspected) ||
      (state.quotaResetAt !== null && !isTimestamp(state.quotaResetAt))
    )
      throw invalid();
    return {
      inspected: new Map(
        Object.entries(state.inspected).map(
          ([url, at]: [string, unknown]): [string, string] => {
            if (!isTimestamp(at)) throw invalid();
            return [url, at];
          },
        ),
      ),
      quotaResetAt:
        state.quotaResetAt === null
          ? Number.NEGATIVE_INFINITY
          : Date.parse(state.quotaResetAt),
      diff: state.diff,
    };
  }
}
