import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type {
  AccountDocument,
  CalendarDocument,
  EventKitDocument,
  HelperCalendarDocument,
  HelperRequest,
} from './documents.ts';
import { EventKitChangingError } from './errors.ts';
import nativeProcess from './native-process.ts';

// The compiled helper (helper/*.swift) sits next to this module in dist and
// next to the plugin's bundled server.
const helper = fileURLToPath(new URL('./eventkit-helper', import.meta.url));

// EventKit posts EKEventStoreChangedNotification up to this long after a change.
const settleMs = 250;
const attempts = 5;

// The accounts and calendars a read covers; leaving both out reads all of them.
export type EventKitQuery = {
  readonly accountIds?: readonly string[];
  readonly calendarIds?: readonly string[];
};

export type Collections = {
  readonly accounts: readonly AccountDocument[];
  readonly calendars: readonly CalendarDocument[];
};

// One EventKit entity type, read through the helper process. Reading, retrying
// until the store holds still, scoping and watching are the same for events
// and reminders; a store supplies its entity, its own request fields, how its
// items group, and its access failure.
export abstract class EventKitStore<Query extends EventKitQuery, Contents> {
  protected abstract readonly entity: 'events' | 'reminders';
  // What the helper writes to stderr when access to the entity is missing.
  protected abstract readonly accessMarker: string;

  // EventKit has no read transaction. Reads run while a watcher counts
  // EKEventStoreChangedNotification and repeat when a change arrived during
  // them or within settleMs after.
  async read(query: Query): Promise<Contents> {
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
        const contents = await this.#readOnce(query);
        await sleep(settleMs);
        if (failure !== undefined) throw failure.error;
        if (count === before) return contents;
      }
      throw new EventKitChangingError(this.entity, attempts);
    } finally {
      controller.abort();
      await counting;
    }
  }

  // Yields once the subscription is confirmed, then once per store change.
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
      throw this.failure(error);
    }
  }

  protected abstract request(
    query: Query,
  ): Omit<HelperRequest, 'entity' | 'accountIds' | 'collectionIds'>;

  protected abstract contents(
    collections: Collections,
    documents: readonly EventKitDocument[],
  ): Contents;

  protected abstract accessDenied(cause: unknown): Error;

  protected failure(error: unknown): unknown {
    return helperStderr(error).includes(this.accessMarker)
      ? this.accessDenied(error)
      : error;
  }

  async #readOnce(query: Query): Promise<Contents> {
    const request: HelperRequest = {
      entity: this.entity,
      ...this.request(query),
      accountIds: query.accountIds,
      collectionIds: query.calendarIds,
    };
    const documents: EventKitDocument[] = [];
    try {
      for await (const line of nativeProcess.lines(helper, [
        'read',
        JSON.stringify(request),
      ]))
        documents.push(inContentOrder(JSON.parse(line)));
    } catch (error) {
      throw this.failure(error);
    }
    return this.contents(scoped(query, documents), documents);
  }
}

export function helperStderr(error: unknown): string {
  return error instanceof Error &&
    'stderr' in error &&
    typeof error.stderr === 'string'
    ? error.stderr
    : '';
}

// The helper writes every account and calendar of the entity. A scoped read
// keeps the calendars it selected and the accounts the query names; a calendar
// scope also drops the accounts that own no selected calendar.
function scoped(
  query: EventKitQuery,
  documents: readonly EventKitDocument[],
): Collections {
  const accounts = documents.filter((document) => document.type === 'account');
  const calendars = documents.filter(
    (document) => document.type === 'calendar',
  );
  if (query.accountIds === undefined && query.calendarIds === undefined)
    return { accounts, calendars: calendars.map(withoutSelection) };
  const selected = calendars
    .filter((calendar) => calendar.selected)
    .map(withoutSelection);
  return {
    accounts: accounts.filter(
      (account) =>
        (query.accountIds?.includes(account.id) ?? true) &&
        (query.calendarIds === undefined ||
          selected.some((calendar) => calendar.accountId === account.id)),
    ),
    calendars: selected,
  };
}

function withoutSelection({
  selected,
  ...calendar
}: HelperCalendarDocument): CalendarDocument {
  return calendar;
}

// EventKit returns an item's attendees and alarms in a different order in
// each process (verified live), so they are sorted by their content. A reply
// changes an attendee's status, so status does not order attendees.
function inContentOrder(document: EventKitDocument): EventKitDocument {
  if (!('attendees' in document)) return document;
  return {
    ...document,
    attendees: sorted(document.attendees, (attendee) => [
      attendee.url,
      attendee.name ?? null,
      attendee.role,
      attendee.participantType,
    ]),
    alarms: sorted(document.alarms, (alarm) => [
      alarm.alarmType,
      alarm.relativeOffset,
      alarm.absoluteMs ?? null,
      alarm.emailAddress ?? null,
      alarm.soundName ?? null,
      alarm.proximity,
      alarm.location?.title ?? null,
      alarm.location?.latitude ?? null,
      alarm.location?.longitude ?? null,
      alarm.location?.radius ?? null,
    ]),
  };
}

function sorted<T>(values: readonly T[], key: (value: T) => unknown): T[] {
  return values
    .map((value) => [JSON.stringify(key(value)), value] as const)
    .sort(([a], [b]) => {
      if (a < b) return -1;
      return a > b ? 1 : 0;
    })
    .map(([, value]) => value);
}
