import type { RecordMessage } from '@workspace/elt';

import type { GoogleHealthScan } from './google-health-scan.ts';
import { GoogleHealthStream } from './google-health-stream.ts';

/** What the account itself holds: its identity, profile, settings and devices. */
export abstract class AccountStream extends GoogleHealthStream {
  async *extract(
    scan: GoogleHealthScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<RecordMessage> {
    yield* this.records(await this.rows(scan, signal));
  }

  protected abstract rows(
    scan: GoogleHealthScan,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>[]>;
}
