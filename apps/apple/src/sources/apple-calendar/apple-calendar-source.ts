import { lstat, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceWatchOptions,
  Stream,
} from 'elt';
import {
  diffSnapshot,
  isTimestamp,
  Source,
  type SourceMessage,
  validateRecords,
} from 'elt';
import {
  EventKit,
  type EventKitRequest,
  EventKitSnapshot,
} from '../../platform/macos/eventkit.ts';
import {
  eventKitAccountFields,
  eventKitCalendarFields,
  eventKitCatalog,
  eventKitFields,
  eventKitRelatedFields,
} from '../eventkit-schema.ts';
import type { ImportScope } from '../import-scope.ts';
import { calendarRows } from './calendar-rows.ts';
import { isIcsStream } from './ics-records.ts';

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
    icsComponents: {
      id,
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

export class AppleCalendarSource extends Source<EventKitSnapshot> {
  readonly #eventKit = new EventKit('events');
  // The window is not part of the identity: moving it keeps one checkpoint, and
  // incremental copies delete the occurrences that left it.
  readonly identity = 'apple-calendar:eventkit';
  protected readonly catalog = catalog;
  readonly startAt: string;
  readonly endAt: string;
  readonly scope: ImportScope;
  readonly accounts = catalog.get('accounts');
  readonly calendars = catalog.get('calendars');
  readonly events = catalog.get('events');
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
    scope = {},
  }: {
    startAt: string;
    endAt: string;
    // Retrieves remote ATTACH files; only needed when a copy reads their bytes.
    attachments?: CalendarAttachmentFetcher;
    scope?: ImportScope;
  }) {
    super();
    this.#attachments = attachments;
    if (!isTimestamp(startAt) || !isTimestamp(endAt) || startAt >= endAt)
      throw new TypeError(
        'Calendar requires canonical UTC startAt < endAt timestamps',
      );
    this.startAt = startAt;
    this.endAt = endAt;
    this.scope = scope;
    Object.freeze(this);
  }

  override coverage(stream: Stream): ExtractionCoverage {
    if (stream === this.accounts || stream === this.calendars)
      return {
        description:
          'All Calendar accounts or calendars visible through EventKit on this Mac. No date filter; the event window does not restrict these listings.',
        selection: this.scope,
      };
    return {
      description:
        'EventKit event occurrences overlapping the configured UTC interval [startAt, endAt); zero-duration events must start within it. Related rows and ICS exports belong to those selected events; ICS may describe a recurring series beyond the interval. Only calendars visible on this Mac are included. This is a requested window, not observed event dates. Attachment metadata may exist without retrievable file bytes.',
      selection: { ...this.scope, startAt: this.startAt, endAt: this.endAt },
    };
  }

  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    for await (const _ of this.#eventKit.watch(signal)) yield streams;
  }

  // Every selected stream from one change-free read, so occurrences match
  // their calendars and ICS rows their items.
  protected override async open(
    streams: readonly Stream[],
  ): Promise<EventKitSnapshot> {
    const { accountIds, collectionIds } = this.scope;
    const request = {
      startAt: this.startAt,
      endAt: this.endAt,
      ics: streams.some((stream) => isIcsStream(stream.name)),
      accountIds,
      collectionIds,
    };
    return new EventKitSnapshot(
      await this.#eventKit.consistently(async () => {
        const rows = calendarRows(await this.#read(request), this.scope);
        return new Map(
          streams.map((stream) => {
            const records = validateRecords(
              stream,
              rows.get(stream.name),
              'EventKit',
            );
            if (stream.name === 'events') records.forEach(checkEventDates);
            return [stream.name, records];
          }),
        );
      }),
    );
  }

  async #read(request: EventKitRequest) {
    try {
      return await this.#eventKit.read(request);
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
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    snapshot: EventKitSnapshot,
  ): AsyncGenerator<SourceMessage> {
    const { stream, syncMode } = configuration;
    const records = snapshot.of(stream.name);
    if (syncMode === 'incremental') {
      for await (const message of diffSnapshot(stream, records, state))
        if ('type' in message) yield message;
        else yield* this.withFile(configuration, message.data);
      return;
    }
    for (const data of records) yield* this.withFile(configuration, data);
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
}

function checkEventDates(event: Record<string, unknown>): void {
  if (
    String(event.endAt) < String(event.startAt) ||
    (event.allDay
      ? event.startDate === null ||
        event.endDate === null ||
        String(event.endDate) < String(event.startDate)
      : event.startDate !== null || event.endDate !== null)
  )
    throw new TypeError('Calendar returned inconsistent event dates');
}
