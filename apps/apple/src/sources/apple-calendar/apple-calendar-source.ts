import { lstat, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { CopyConfiguration, SourceWatchOptions, Stream } from 'elt';
import {
  diffSnapshot,
  isTimestamp,
  Source,
  type SourceMessage,
  validateRecords,
} from 'elt';
import { EventKit } from '../../platform/macos/eventkit.ts';
import {
  eventKitAccountFields,
  eventKitCalendarFields,
  eventKitCatalog,
  eventKitFields,
  eventKitRelatedFields,
} from '../eventkit-schema.ts';
import { calendarScript } from './calendar-script.ts';
import { icsRecords, isIcsStream, validateIcsExports } from './ics-records.ts';

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

const catalog = eventKitCatalog(
  {
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
    icsComponents: {
      id,
      eventMetadataId: id,
      calendarId: id,
      calendarItemId: id,
      parentId: nullableText,
      position: ordinal,
      name: text,
      uid: nullableText,
      recurrenceId: nullableText,
      recurrenceIdTimeZone: nullableText,
      eventId: nullableText,
    },
    icsProperties: {
      id,
      componentId: id,
      calendarId: id,
      calendarItemId: id,
      position: ordinal,
      name: text,
      value: text,
    },
    icsAttachments: {
      id,
      propertyId: id,
      componentId: id,
      calendarId: id,
      calendarItemId: id,
      uri: text,
      filename: nullableText,
      formatType: nullableText,
      inline: boolean,
    },
    icsParameters: {
      id,
      propertyId: id,
      componentId: id,
      calendarId: id,
      calendarItemId: id,
      position: ordinal,
      valuePosition: ordinal,
      name: text,
      value: text,
    },
    ...eventKitRelatedFields('eventId'),
  },
  { snapshot: true, fileTransfer: ['icsAttachments'] },
);

export type CalendarAttachment = {
  readonly uri: string;
  readonly filename: string | null;
  readonly formatType: string | null;
  readonly calendarId: string;
  readonly calendarItemId: string;
};

// Writes the attachment's bytes to path and resolves true, or resolves false
// when the file is definitively not retrievable (no access, unsupported host).
// Any other failure must reject: it fails the copy instead of loading no file.
export type CalendarAttachmentFetcher = (
  attachment: CalendarAttachment,
  path: string,
) => Promise<boolean>;

export class CalendarIcsUnavailableError extends Error {
  override name = 'CalendarIcsUnavailableError';

  constructor(cause: unknown) {
    super(
      'This macOS version does not provide the private EventKit ICS export that the Calendar ICS streams read. Select the other Calendar streams, which use public EventKit.',
      { cause },
    );
  }
}

export class AppleCalendarSource extends Source {
  readonly #eventKit = new EventKit('events');
  // The window is not part of the identity: moving it keeps one checkpoint, and
  // incremental copies delete the occurrences that left it.
  readonly identity = 'apple-calendar:eventkit';
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
  readonly icsComponents = catalog.get('icsComponents');
  readonly icsProperties = catalog.get('icsProperties');
  readonly icsParameters = catalog.get('icsParameters');
  readonly icsAttachments = catalog.get('icsAttachments');

  readonly #attachments?: CalendarAttachmentFetcher;

  constructor({
    startAt,
    endAt,
    attachments,
  }: {
    startAt: string;
    endAt: string;
    // Retrieves remote ATTACH files; only needed when a copy reads their bytes.
    attachments?: CalendarAttachmentFetcher;
  }) {
    super();
    this.#attachments = attachments;
    if (!isTimestamp(startAt) || !isTimestamp(endAt) || startAt >= endAt)
      throw new TypeError(
        'Calendar requires canonical UTC startAt < endAt timestamps',
      );
    this.startAt = startAt;
    this.endAt = endAt;
    Object.freeze(this);
  }

  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    for await (const _ of this.#eventKit.watch(signal)) yield streams;
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
  ): AsyncGenerator<SourceMessage> {
    const { stream, syncMode } = configuration;
    if (syncMode === 'incremental') {
      for await (const message of diffSnapshot(
        stream,
        this.scan(stream),
        state,
      ))
        if ('type' in message) yield message;
        else yield* this.withFile(configuration, message.data);
      return;
    }
    for await (const data of this.scan(stream))
      yield* this.withFile(configuration, data);
  }

  // Stages an attachment's bytes when the copy reads them, like Notes attachments.
  private async *withFile(
    configuration: CopyConfiguration,
    data: Record<string, unknown>,
  ): AsyncGenerator<SourceMessage> {
    const stream = configuration.stream.name;
    if (stream !== 'icsAttachments' || configuration.fileReads.length === 0) {
      yield { stream, data };
      return;
    }
    const attachment = {
      uri: String(data.uri),
      // Validated against the icsAttachments schema: nullable text.
      filename: data.filename as string | null,
      formatType: data.formatType as string | null,
      calendarId: String(data.calendarId),
      calendarItemId: String(data.calendarItemId),
    };
    await using scratch = await mkdtempDisposable(
      join(tmpdir(), 'mac-elt-calendar-attachment-'),
    );
    const extension =
      attachment.filename === null ? '' : extname(attachment.filename);
    const path = join(scratch.path, `content${extension}`);
    let saved: boolean;
    if (data.inline === true) {
      await writeFile(path, Buffer.from(attachment.uri, 'base64'));
      saved = true;
    } else {
      if (this.#attachments === undefined)
        throw new TypeError(
          'Reading Calendar attachment files requires an attachments fetcher: new AppleCalendarSource({ ..., attachments })',
        );
      saved = await this.#attachments(attachment, path);
    }
    if (saved && !(await lstat(path)).isFile())
      throw new TypeError(
        'The attachment fetcher did not write a regular file',
      );
    yield { stream, data, file: saved ? path : null };
  }

  // One complete read of the window, each record once.
  private async *scan(stream: Stream): AsyncGenerator<Record<string, unknown>> {
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
        // Every Calendar stream's schema requires a text id.
        const key = data.id as string;
        if (seen.has(key)) continue;
        seen.add(key);
        yield data;
      }
      startAt = endAt;
    } while (startAt < this.endAt);
  }

  private async *readWindow(
    stream: Stream,
    startAt: string,
    endAt: string,
  ): AsyncGenerator<Record<string, unknown>> {
    const ics = isIcsStream(stream.name) ? stream.name : undefined;
    // Metadata and ICS streams page by native item with a monotonic cursor.
    const paged =
      stream.name === 'eventMetadata' ||
      stream.name === 'excludedDates' ||
      ics !== undefined;
    let cursor: string | null = null;
    do {
      let response: unknown;
      try {
        response = await this.#eventKit.execute(`
          ${calendarScript}
          return readCalendar(store, ${JSON.stringify(stream.name)}, ${JSON.stringify(startAt)}, ${JSON.stringify(endAt)}${paged ? `, undefined, ${JSON.stringify(cursor)}` : ''});
        `);
      } catch (error) {
        if (
          error instanceof Error &&
          'stderr' in error &&
          typeof error.stderr === 'string' &&
          error.stderr.includes('CALENDAR_ICS_UNAVAILABLE')
        )
          throw new CalendarIcsUnavailableError(error);
        throw error;
      }
      if (paged) {
        // readCalendar's page. A cursor that does not advance would page
        // forever, so it fails the copy.
        const page = response as {
          records: unknown;
          nextCursor: string | null;
        };
        if (page.nextCursor !== null && page.nextCursor <= (cursor ?? ''))
          throw new TypeError('Calendar returned an invalid metadata page');
        cursor = page.nextCursor;
        response = page.records;
      }
      if (ics !== undefined)
        response = validateIcsExports(response).flatMap((item) =>
          icsRecords(ics, item),
        );
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
