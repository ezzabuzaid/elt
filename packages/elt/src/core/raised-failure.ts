import { errorMessage } from '../state/sync-history.ts';
import { EscalatedFailure } from './escalated-failure.ts';
import type { FailureType } from './source.ts';

// A side of a replication that names the failure type of what it raised: the
// source, the destination, a checkpoint store or a file storage (ADR 0029).
export type FailureSide = {
  failureType(error: unknown): FailureType;
};

// What a side threw, with the failure type that the side named. error is
// what the failure records.
export class RaisedFailure extends Error {
  override name = 'RaisedFailure';
  readonly error: unknown;
  readonly failureType: FailureType;

  constructor(error: unknown, failureType: FailureType) {
    super(errorMessage(error), { cause: error });
    this.error = error;
    this.failureType = failureType;
  }
}

// Calls into side, and throws what fails as a RaisedFailure of side. A
// failure that another side raised inside the call, such as a read of the
// source's file content inside a save of a file storage, stays that side's,
// and an escalated failure stays as it is (ADR 0037).
export async function raised<T>(
  side: FailureSide,
  call: () => PromiseLike<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw raisedFrom(side, error);
  }
}

export function raisedFrom(
  side: FailureSide,
  error: unknown,
): RaisedFailure | EscalatedFailure {
  return error instanceof RaisedFailure || error instanceof EscalatedFailure
    ? error
    : new RaisedFailure(error, side.failureType(error));
}
