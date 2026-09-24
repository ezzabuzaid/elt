import type { CopyConfiguration, SourceWatchOptions, Stream } from 'elt';
import { isTimestamp, type RecordMessage, Source, validateRecords } from 'elt';
import { EventKit } from '../../platform/macos/eventkit.ts';
import {
  eventKitAccountFields,
  eventKitCalendarFields,
  eventKitCatalog,
  eventKitFields,
  eventKitRelatedFields,
} from '../eventkit-schema.ts';
import { calendarScript } from './calendar-script.ts';

const {
  id,
  text,
  nullableText,
  timestamp,
  nullableTimestamp,
  nullableDate,
  boolean,
  ordinal,
  integer,
  location,
} = eventKitFields;

const catalog = eventKitCatalog({
  accounts: eventKitAccountFields,
  calendars: { ...eventKitCalendarFields, description: text },
  events: {
    id,
    eventId: id,
    calendarId: id,
    calendarItemId: id,
    externalId: nullableText,
    nativeEventId: nullableText,
    name: text,
    body: nullableText,
    location: nullableText,
    url: nullableText,
    startAt: timestamp,
    endAt: timestamp,
    allDay: boolean,
    startDate: nullableDate,
    endDate: nullableDate,
    timeZone: nullableText,
    createdAt: nullableTimestamp,
    modifiedAt: nullableTimestamp,
    occurrenceAt: nullableTimestamp,
    occurrenceDate: nullableDate,
    detached: boolean,
    status: ordinal,
    availability: integer,
    birthdayContactId: nullableText,
    ...location,
  },
  eventMetadata: {
    id,
    calendarId: id,
    calendarItemId: id,
    scriptingUid: id,
    rawRecurrence: nullableText,
    sequence: integer,
  },
  excludedDates: {
    id,
    eventMetadataId: id,
    position: ordinal,
    excludedAt: timestamp,
    excludedDate: nullableDate,
  },
  ...eventKitRelatedFields('eventId'),
});

export class AppleCalendarSource extends Source {
  readonly #eventKit = new EventKit('events');
  readonly identity: string;
  protected readonly catalog = catalog;
  readonly startAt: string;
  readonly endAt: string;
  readonly accounts = catalog.get('accounts');
  readonly calendars = catalog.get('calendars');
  readonly events = catalog.get('events');
  readonly eventMetadata = catalog.get('eventMetadata');
  readonly excludedDates = catalog.get('excludedDates');
  readonly attendees = catalog.get('attendees');
  readonly alarms = catalog.get('alarms');
  readonly recurrenceRules = catalog.get('recurrenceRules');
  readonly recurrenceRuleValues = catalog.get('recurrenceRuleValues');

  constructor({ startAt, endAt }: { startAt: string; endAt: string }) {
    super();
    if (!isTimestamp(startAt) || !isTimestamp(endAt) || startAt >= endAt)
      throw new TypeError(
        'Calendar requires canonical UTC startAt < endAt timestamps',
      );
    this.startAt = startAt;
    this.endAt = endAt;
    this.identity = JSON.stringify({
      type: 'apple-calendar:eventkit',
      startAt,
      endAt,
    });
    Object.freeze(this);
  }

  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    for await (const _ of this.#eventKit.watch(signal)) yield streams;
  }

  protected override async *extract(
    { stream }: CopyConfiguration,
    _state: unknown,
  ): AsyncGenerator<RecordMessage> {
    const metadata = stream.name === 'accounts' || stream.name === 'calendars';
    const seen = new Set<string>();
    let startAt = this.startAt;
    do {
      // EventKit silently truncates queries longer than four years. Smaller windows
      // also bound each OSA response; overlapping events are emitted once per copy.
      const endAt = metadata
        ? this.endAt
        : new Date(
            Math.min(
              Date.parse(startAt) + 365 * 24 * 60 * 60 * 1000,
              Date.parse(this.endAt),
            ),
          ).toISOString();
      for await (const data of this.readWindow(stream, startAt, endAt)) {
        const key = data.id;
        if (typeof key !== 'string')
          throw new TypeError('Calendar returned an invalid id');
        if (seen.has(key)) continue;
        seen.add(key);
        yield { stream: stream.name, data };
      }
      startAt = endAt;
    } while (startAt < this.endAt);
  }

  private async *readWindow(
    stream: Stream,
    startAt: string,
    endAt: string,
  ): AsyncGenerator<Record<string, unknown>> {
    const scripting =
      stream.name === 'eventMetadata' || stream.name === 'excludedDates';
    let cursor: string | null = null;
    do {
      let response = await this.#eventKit.execute(`
        ${calendarScript}
        return readCalendar(store, ${JSON.stringify(stream.name)}, ${JSON.stringify(startAt)}, ${JSON.stringify(endAt)}${scripting ? `, undefined, ${JSON.stringify(cursor)}` : ''});
      `);
      if (scripting) {
        if (
          !response ||
          typeof response !== 'object' ||
          !('records' in response) ||
          !('nextCursor' in response) ||
          (response.nextCursor !== null &&
            (typeof response.nextCursor !== 'string' ||
              response.nextCursor <= (cursor ?? '')))
        )
          throw new TypeError('Calendar returned an invalid metadata page');
        cursor = response.nextCursor;
        response = response.records;
      }
      for (const record of validateRecords(stream, response, 'EventKit')) {
        if (
          stream.name === 'events' &&
          (record.id !== record.eventId ||
            String(record.endAt) < String(record.startAt) ||
            (record.allDay
              ? record.startDate === null ||
                record.endDate === null ||
                String(record.endDate) < String(record.startDate)
              : record.startDate !== null || record.endDate !== null))
        )
          throw new TypeError(
            'Calendar returned inconsistent event dates or identity',
          );
        yield record;
      }
    } while (cursor !== null);
  }
}
