import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { EventKitDocument } from './eventkit-documents.ts';
import nativeProcess from './native-process.ts';

export class CalendarUnavailableError extends Error {
  override name = 'CalendarUnavailableError';

  constructor(cause: unknown) {
    super(
      'Calendar requires full Calendar access for the process running the export. Allow access in System Settings > Privacy & Security > Calendars. A sandbox can prevent access even when permission is granted.',
      { cause },
    );
  }
}

export class RemindersUnavailableError extends Error {
  override name = 'RemindersUnavailableError';

  constructor(cause: unknown) {
    super(
      'Reminders requires full Reminders access for the process running the export. Allow access in System Settings > Privacy & Security > Reminders. A sandbox can prevent access even when permission is granted.',
      { cause },
    );
  }
}

export class EventKitChangingError extends Error {
  override name = 'EventKitChangingError';

  constructor(entity: string, attempts: number) {
    super(
      `EventKit ${entity} changed during each of ${attempts} consistent reads; run the export again when edits settle.`,
    );
  }
}

// Every selected stream's records, read in one change-free window.
export class EventKitSnapshot implements AsyncDisposable {
  readonly records: ReadonlyMap<string, readonly Record<string, unknown>[]>;

  constructor(
    records: ReadonlyMap<string, readonly Record<string, unknown>[]>,
  ) {
    this.records = records;
  }

  of(stream: string): readonly Record<string, unknown>[] {
    const records = this.records.get(stream);
    if (records === undefined)
      throw new TypeError(`Stream ${stream} was not read in this session`);
    return records;
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}

export type EventKitRequest = {
  // Calendar's requested UTC interval.
  readonly startAt?: string;
  readonly endAt?: string;
  // Export each event item's iCalendar data through private EventKit API.
  readonly ics?: boolean;
  readonly accountIds?: readonly string[];
  readonly collectionIds?: readonly string[];
};

// The compiled helper (platform/macos/eventkit/*.swift) sits next to this
// module in dist and next to the plugin's bundled server.
const helper = fileURLToPath(new URL('./eventkit', import.meta.url));

export class EventKit {
  readonly entity: 'events' | 'reminders';

  constructor(entity: 'events' | 'reminders') {
    this.entity = entity;
  }

  // One read of the whole store, in one helper process.
  async read(request: EventKitRequest): Promise<EventKitDocument[]> {
    const documents: EventKitDocument[] = [];
    try {
      for await (const line of nativeProcess.lines(helper, [
        'read',
        JSON.stringify({ entity: this.entity, ...request }),
      ]))
        documents.push(JSON.parse(line));
    } catch (error) {
      throw this.unavailable(error);
    }
    return documents;
  }

  // EventKit has no read transaction. Reads run while a watcher counts
  // EKEventStoreChangedNotification and repeat when a change arrived during
  // them or within settleMs after, the notification's delivery delay.
  async consistently<T>(
    read: () => Promise<T>,
    { settleMs = 250, attempts = 5 } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const changes = this.watch(controller.signal)[Symbol.asyncIterator]();
    let count = 0;
    let failure: { error: unknown } | undefined;
    // The watcher's first notification only confirms the subscription.
    await changes.next();
    const counting = (async () => {
      try {
        while (!(await changes.next()).done) count++;
      } catch (error) {
        if (!controller.signal.aborted) failure = { error };
      }
    })();
    try {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const before = count;
        const value = await read();
        await sleep(settleMs);
        if (failure !== undefined) throw failure.error;
        if (count === before) return value;
      }
      throw new EventKitChangingError(this.entity, attempts);
    } finally {
      controller.abort();
      await counting;
    }
  }

  async *watch(signal: AbortSignal): AsyncGenerator<void> {
    try {
      for await (const message of nativeProcess.lines(
        helper,
        ['watch', this.entity],
        signal,
      )) {
        if (message !== 'changed')
          throw new TypeError(
            'EventKit watcher returned an invalid notification',
          );
        yield;
      }
      if (!signal.aborted)
        throw new Error('EventKit watcher stopped unexpectedly');
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  private get marker(): string {
    return this.entity === 'events'
      ? 'CALENDAR_UNAVAILABLE'
      : 'REMINDERS_UNAVAILABLE';
  }

  private unavailable(error: unknown): unknown {
    if (
      error instanceof Error &&
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      error.stderr.includes(this.marker)
    ) {
      const Unavailable =
        this.entity === 'events'
          ? CalendarUnavailableError
          : RemindersUnavailableError;
      return new Unavailable(error);
    }
    return error;
  }
}
