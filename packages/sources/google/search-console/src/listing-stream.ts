import { ClosedWorld } from '@zukhruf/snapshot-differential';

import {
  type CopyConfiguration,
  type Partition,
  type SourceMessage,
  diffSnapshot,
  validateRecords,
} from '@workspace/elt';

import type { SearchConsoleScan } from './search-console-scan.ts';
import {
  SearchConsoleStream,
  type StreamDefinition,
} from './search-console-stream.ts';

// A stream Google returns whole on every read, so an incremental copy diffs
// each read with the previous snapshot and deletes the rows it lost.
export abstract class ListingStream extends SearchConsoleStream {
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
    const rows = await this.list(partition, scan, signal);
    yield* diffSnapshot(
      configuration,
      validateRecords(this.stream, rows, 'Search Console'),
      state,
      { policy: new ClosedWorld() },
    );
  }

  protected abstract list(
    partition: Partition | null,
    scan: SearchConsoleScan,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>[]>;
}
