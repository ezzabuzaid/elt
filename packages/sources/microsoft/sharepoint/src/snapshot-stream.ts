import { ClosedWorld } from '@zukhruf/snapshot-differential';

import {
  type CopyConfiguration,
  type SourceMessage,
  diffSnapshot,
} from '@eltjs/elt';

import type { SharePointRun } from './sharepoint-run.ts';
import { SharePointStream } from './sharepoint-stream.ts';

/**
 * A stream that Graph lists whole on each read, with no change feed: an
 * incremental copy compares each read with the snapshot of the last one,
 * writes what changed and deletes what Graph no longer lists. A restricted
 * stream lists nothing for a site limited to folders, so the diff deletes
 * what an earlier read of the whole site loaded.
 */
export abstract class SnapshotStream extends SharePointStream {
  async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    siteUrl: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<SourceMessage> {
    const scope = await run.scope(siteUrl, signal);
    yield* diffSnapshot(
      configuration,
      this.restricted && scope !== 'site'
        ? []
        : this.#records(siteUrl, run, signal),
      state,
      { policy: new ClosedWorld(), signal },
    );
  }

  // The pages of a collection can give one item twice, as when it changes
  // while a read pages through them, and a snapshot diff fails on a key that
  // a scan gives twice. The last one is the newest.
  async *#records(
    siteUrl: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>> {
    const records = new Map<string, Record<string, unknown>>();
    for await (const draft of this.scan(siteUrl, run, signal)) {
      const record = this.validated(draft);
      const key = this.stream.primaryKey.map((field) => record[field]);
      records.set(JSON.stringify(key), record);
    }
    yield* records.values();
  }

  // Every record of the site, as Graph lists it now.
  protected abstract scan(
    siteUrl: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncIterable<Record<string, unknown>>;
}
