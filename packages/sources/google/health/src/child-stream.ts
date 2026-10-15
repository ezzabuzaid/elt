import type { RecordMessage } from '@workspace/elt';
import type { DataPoint, ListedDataType } from '@workspace/sdk-google-health';

import type { GoogleHealthScan } from './google-health-scan.ts';
import {
  GoogleHealthStream,
  type StreamDefinition,
} from './google-health-stream.ts';

export type ChildStreamDefinition = StreamDefinition & {
  readonly parent: ListedDataType;
};

/**
 * A list inside each point of a type, such as a sleep's stages, one record
 * per entry. It reads the same points as its parent's stream in this run.
 */
export abstract class ChildStream extends GoogleHealthStream {
  readonly parent: ListedDataType;

  constructor({ parent, ...definition }: ChildStreamDefinition) {
    super(definition);
    this.parent = parent;
  }

  async *extract(
    scan: GoogleHealthScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<RecordMessage> {
    const points = await scan.shared(this.parent, signal);
    yield* this.records(points.flatMap((point) => this.rows(point)));
  }

  protected abstract rows(point: DataPoint): Record<string, unknown>[];
}
