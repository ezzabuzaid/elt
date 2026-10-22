import type {
  Call,
  CallHistorySnapshot,
  CallTimers,
  EmergencyMediaItem,
  Participant,
  SaintDavidsCount,
} from '@workspace/sdk-apple-call-history';
import {
  type ImportScope,
  withinDates,
} from '@workspace/source-apple-macos/import-scope';

// A start time cut to the millisecond, the precision of an import's dates, so
// it compares with them as text: cutting keeps every call on the same side of
// a millisecond boundary, where a longer fraction would sort before it.
const toMilliseconds = (instant: string) => `${instant.slice(0, 23)}Z`;

// One run's read of the call history store: every stream reads the same
// snapshot, and the import scope's dates keep calls that started within them
// and the records of those calls. A record that belongs to no call has no
// date to fall outside, so it stays. Records are read as each stream iterates
// them, never held for the run: a store keeps tens of thousands of calls.
export class CallHistoryScan implements AsyncDisposable {
  readonly #snapshot: CallHistorySnapshot;
  readonly #scope: ImportScope;
  #callIds?: ReadonlySet<string>;

  constructor(snapshot: CallHistorySnapshot, scope: ImportScope) {
    this.#snapshot = snapshot;
    this.#scope = scope;
  }

  calls(): IteratorObject<Call, undefined> {
    return this.#snapshot
      .calls()
      .filter(({ startedAt }) =>
        withinDates(
          this.#scope,
          startedAt === null ? null : toMilliseconds(startedAt),
        ),
      );
  }

  // Each call keeps its own copy of a handle, and nothing stops two copies of
  // one handle on a call; the first stands for both.
  *participants(): Generator<Participant> {
    const seen = new Set<string>();
    for (const participant of this.#snapshot.participants()) {
      const key = JSON.stringify([
        participant.callId,
        participant.handle.type,
        participant.handle.value,
      ]);
      if (seen.has(key) || !this.#selected(participant.callId)) continue;
      seen.add(key);
      yield participant;
    }
  }

  timers(): IteratorObject<CallTimers, undefined> {
    return this.#snapshot.timers();
  }

  emergencyMediaItems(): IteratorObject<EmergencyMediaItem, undefined> {
    return this.#snapshot
      .emergencyMediaItems()
      .filter(({ callId }) => callId === null || this.#selected(callId));
  }

  saintDavidsCounts(): IteratorObject<SaintDavidsCount, undefined> {
    return this.#snapshot
      .saintDavidsCounts()
      .filter(({ callId }) => callId === null || this.#selected(callId));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#snapshot[Symbol.dispose]();
  }

  #selected(callId: string): boolean {
    if (this.#scope.startAt === undefined && this.#scope.endAt === undefined)
      return true;
    this.#callIds ??= new Set(this.calls().map(({ id }) => id));
    return this.#callIds.has(callId);
  }
}
