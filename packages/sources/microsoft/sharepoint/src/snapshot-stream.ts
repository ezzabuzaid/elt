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
 * writes what changed and deletes what Graph no longer lists.
 */
export abstract class SnapshotStream extends SharePointStream {
  async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    siteUrl: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<SourceMessage> {
    yield* diffSnapshot(
      configuration,
      this.#records(siteUrl, run, signal),
      state,
      { policy: new ClosedWorld(), signal },
    );
  }

  async *#records(
    siteUrl: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>> {
    for await (const draft of this.scan(siteUrl, run, signal))
      yield this.validated(draft);
  }

  // Every record of the site, as Graph lists it now.
  protected abstract scan(
    siteUrl: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncIterable<Record<string, unknown>>;
}
