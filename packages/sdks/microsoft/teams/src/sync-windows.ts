import type { Fields } from './fields.ts';

type SyncWindow = {
  readonly start: number;
  readonly end: number;
  readonly toStartOfTime: boolean;
};

// The span of each conversation's history the client holds, from its sync
// states: one per conversation, keyed by its id, and one per channel thread it
// has opened, keyed <channel>;messageid=<thread>. The client loads a span
// whole, and when it prunes its cache it moves the span's start, so a message
// inside a span that the client no longer holds was deleted. A conversation
// the client has not loaded keeps an empty span (start after end).
export class SyncWindows {
  readonly #windows: ReadonlyMap<string, SyncWindow>;

  constructor(states: readonly Fields[]) {
    const windows = new Map<string, SyncWindow>();
    for (const state of states) {
      const id = state.string('id');
      const start = state.number('chatServiceStartOfSyncWindow');
      const end = state.number('chatServiceEndOfSyncWindow');
      // A span with a gap in it says nothing about what is missing there.
      if (
        id === null ||
        start === null ||
        end === null ||
        state.boolean('isGapDetected') === true
      )
        continue;
      windows.set(id, {
        start,
        end,
        toStartOfTime: state.boolean('_isSyncedToStartOfTime') === true,
      });
    }
    this.#windows = windows;
  }

  // A thread's first message, and every chat message, lies in its
  // conversation's span. A channel loads only the latest replies of each
  // thread with its posts, so a reply lies only in its thread's own span.
  holds(conversationId: string, threadId: string, messageId: string): boolean {
    const time = Number(messageId);
    if (!Number.isFinite(time)) return false;
    const window =
      threadId === messageId
        ? this.#windows.get(conversationId)
        : this.#windows.get(`${conversationId};messageid=${threadId}`);
    return (
      window !== undefined &&
      time <= window.end &&
      (window.toStartOfTime || time >= window.start)
    );
  }
}
