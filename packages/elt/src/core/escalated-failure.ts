import { errorMessage } from '../state/sync-history.ts';

// A failure that no bulkhead of the pipeline holds, as Akka's Escalate hands
// a failure to the supervisor above: it fails no row, no dataset and no copy,
// and the run or the watch rejects with it as itself, so its host can stop,
// such as to restart on newer code. The side that raised the cause wraps it,
// as the side that raised a failure names its type (ADR 0029); the pipeline
// never wraps one, so a host knows it by instanceof (ADR 0037).
export class EscalatedFailure extends Error {
  override readonly name = 'EscalatedFailure';
  declare readonly cause: unknown;

  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
  }
}
