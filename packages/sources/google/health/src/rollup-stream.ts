import type { RecordMessage } from '@workspace/elt';
import type {
  DailyRollupDataPoint,
  RolledUpDataType,
} from '@workspace/sdk-google-health';

import type { GoogleHealthScan } from './google-health-scan.ts';
import {
  GoogleHealthStream,
  type StreamDefinition,
} from './google-health-stream.ts';

export type RollupStreamDefinition = StreamDefinition & {
  readonly type: RolledUpDataType;
};

const DAY_MS = 86_400_000;

/**
 * A type Google answers only as daily totals, such as floors climbed, from the
 * day the user joined through today. A day Google has nothing for is absent.
 */
export abstract class RollupStream extends GoogleHealthStream {
  readonly type: RolledUpDataType;

  constructor({ type, ...definition }: RollupStreamDefinition) {
    super(definition);
    this.type = type;
  }

  async *extract(
    scan: GoogleHealthScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<RecordMessage> {
    const start = await scan.since(signal);
    // The range ends after today wherever the user is: UTC+14 is a day ahead.
    const end = new Date(Date.now() + 2 * DAY_MS).toISOString().slice(0, 10);
    yield* this.records(this.#rows(scan, { end, start }, signal));
  }

  async *#rows(
    scan: GoogleHealthScan,
    range: { readonly start: string; readonly end: string },
    signal: AbortSignal | undefined,
  ) {
    for await (const rollup of scan.api.dailyRollUp(
      this.type,
      range,
      signal && { signal },
    ))
      yield* this.rows(rollup);
  }

  protected abstract rows(
    rollup: DailyRollupDataPoint,
  ): Record<string, unknown>[];
}
