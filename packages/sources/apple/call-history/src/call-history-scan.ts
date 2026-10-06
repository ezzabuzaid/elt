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
// snapshot, each kind of record is read from it once, and the import scope's
// dates keep calls that started within them and the records of those calls.
// A record that belongs to no call has no date to fall outside, so it stays.
export class CallHistoryScan implements AsyncDisposable {
  readonly #snapshot: CallHistorySnapshot;
  readonly #scope: ImportScope;
  #calls?: Call[];
  #callIds?: ReadonlySet<string>;
  #participants?: Participant[];
  #timers?: CallTimers[];
  #emergencyMediaItems?: EmergencyMediaItem[];
  #saintDavidsCounts?: SaintDavidsCount[];

  constructor(snapshot: CallHistorySnapshot, scope: ImportScope) {
    this.#snapshot = snapshot;
    this.#scope = scope;
  }

  get calls(): readonly Call[] {
    this.#calls ??= this.#snapshot
      .calls()
      .filter(({ startedAt }) =>
        withinDates(
          this.#scope,
          startedAt === null ? null : toMilliseconds(startedAt),
        ),
      );
    return this.#calls;
  }

  // Each call keeps its own copy of a handle, and nothing stops two copies of
  // one handle on a call; the first stands for both.
  get participants(): readonly Participant[] {
    if (this.#participants === undefined) {
      const seen = new Set<string>();
      this.#participants = this.#snapshot
        .participants()
        .filter((participant) => {
          const key = JSON.stringify([
            participant.callId,
            participant.handle.type,
            participant.handle.value,
          ]);
          if (seen.has(key) || !this.#selected(participant.callId))
            return false;
          seen.add(key);
          return true;
        });
    }
    return this.#participants;
  }

  get timers(): readonly CallTimers[] {
    this.#timers ??= this.#snapshot.timers();
    return this.#timers;
  }

  get emergencyMediaItems(): readonly EmergencyMediaItem[] {
    this.#emergencyMediaItems ??= this.#snapshot
      .emergencyMediaItems()
      .filter(({ callId }) => callId === null || this.#selected(callId));
    return this.#emergencyMediaItems;
  }

  get saintDavidsCounts(): readonly SaintDavidsCount[] {
    this.#saintDavidsCounts ??= this.#snapshot
      .saintDavidsCounts()
      .filter(({ callId }) => callId === null || this.#selected(callId));
    return this.#saintDavidsCounts;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#snapshot[Symbol.dispose]();
  }

  #selected(callId: string): boolean {
    if (this.#scope.startAt === undefined && this.#scope.endAt === undefined)
      return true;
    this.#callIds ??= new Set(this.calls.map(({ id }) => id));
    return this.#callIds.has(callId);
  }
}
