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
  eventKitLocationFields,
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
} = eventKitFields;

const related = eventKitRelatedFields('eventId');

const perOccurrence =
  'Rows belong to an occurrence, not a series: each selected occurrence of a recurring series repeats them, so counts across a series multiply.';

// ICS rows describe a whole native item, not one occurrence.
const icsItem = {
  calendarId: {
    ...id,
    description:
      'EventKit calendar identifier of the exported item; refers to calendars.id within this source.',
  },
  calendarItemId: {
    ...id,
    description:
      'EventKit EKCalendarItem.calendarItemIdentifier of the exported item. With calendarId it matches events of every occurrence of that item.',
  },
};

const catalog = eventKitCatalog(
  {
    accounts: {
      description:
        "One source record per EventKit account (EKSource) in this Mac's event store, including accounts without event calendars. No date filter: the event window does not restrict it. An import scope keeps the selected accounts; a calendar scope also drops accounts owning no selected calendar. Relationships name source streams, not destination tables.",
      properties: eventKitAccountFields,
    },
    calendars: {
      description:
        'One source record per event calendar visible through EventKit on this Mac. No date filter: the event window does not restrict it. An import scope keeps only the selected calendars. accountId refers to accounts.id; events and ICS rows refer to id through calendarId. Relationships name source streams, not destination tables.',
      properties: {
        ...eventKitCalendarFields,
        description: {
          ...text,
          description:
            "Calendar.app's calendar description, read from EKCalendar's private notes property; empty when the calendar has none.",
        },
      },
    },
    events: {
      description:
        'One source record per event occurrence, not per series: a recurring event yields one record for each occurrence overlapping the configured UTC interval [startAt, endAt); a zero-duration event must start inside it. Key id equals eventId, JSON [calendarId, calendarItemId, occurrenceKey]; never substitute nativeEventId or startAt for it. attendees, alarms, recurrenceRules and recurrenceRuleValues join on eventId. ICS rows describe the whole native item at (calendarId, calendarItemId) and can cover occurrences outside the interval; only a nonrecurring VEVENT carries eventId. startAt and endAt are UTC instants; startDate and endDate are local calendar dates, set for all-day events only. Only calendars visible on this Mac within the import scope are read. Relationships name source streams, not destination tables.',
      properties: {
        id: { ...id, description: 'Same value as eventId; the record key.' },
        eventId: {
          ...id,
          description:
            'Occurrence identity: JSON [calendarId, calendarItemId, occurrenceKey]. occurrenceKey is NULL for a nonrecurring event, occurrenceDate for a recurring all-day event and occurrenceAt for a recurring timed event, so moving an occurrence keeps its identity. An event is recurring when it has recurrence rules or is detached. Related EventKit rows join here.',
        },
        calendarId: {
          ...id,
          description:
            'EventKit EKCalendarItem.calendar.calendarIdentifier; refers to calendars.id within this source.',
        },
        calendarItemId: {
          ...id,
          description:
            'EventKit EKCalendarItem.calendarItemIdentifier of the native item; every occurrence of a recurring series shares it. ICS rows relate on (calendarId, calendarItemId). Apple documents that a full sync can replace it.',
        },
        externalId: {
          ...nullableText,
          description:
            'EventKit EKCalendarItem.calendarItemExternalIdentifier, the server-provided identifier shared by every occurrence of a series; NULL when EventKit has none. Apple documents duplicates across calendars (imports, shared or delegated calendars), so it is not unique.',
        },
        nativeEventId: {
          ...nullableText,
          description:
            'EventKit EKEvent.eventIdentifier; NULL when EventKit has none. Apple documents that it can change when the event moves calendar or syncs; it is not the occurrence identity.',
        },
        name: { ...text, description: 'EventKit EKCalendarItem.title.' },
        body: {
          ...nullableText,
          description: 'EventKit EKCalendarItem.notes; NULL when unset.',
        },
        location: {
          ...nullableText,
          description: 'EventKit EKCalendarItem.location; NULL when unset.',
        },
        url: {
          ...nullableText,
          description:
            'EventKit EKCalendarItem.URL as a string; NULL when unset.',
        },
        startAt: {
          ...timestamp,
          description:
            'EventKit EKEvent.startDate as a UTC timestamp. Apple returns a floating event, such as an all-day event, in the default time zone of the process that read it; use startDate for all-day days.',
        },
        endAt: {
          ...timestamp,
          description:
            'EventKit EKEvent.endDate as a UTC timestamp; never before startAt. Floating events use the reading process time zone, as startAt does.',
        },
        allDay: { ...boolean, description: 'EventKit EKEvent.isAllDay.' },
        startDate: {
          ...nullableDate,
          description:
            'For an all-day event, the local calendar date of EventKit EKEvent.startDate in the default time zone of the process that read it, as Calendar shows it; NULL for a timed event.',
        },
        endDate: {
          ...nullableDate,
          description:
            'For an all-day event, the local calendar date of EventKit EKEvent.endDate in the default time zone of the process that read it, not adjusted to an inclusive or exclusive end; NULL for a timed event.',
        },
        timeZone: {
          ...nullableText,
          description:
            'EventKit EKCalendarItem.timeZone identifier; NULL for a floating event, which Apple documents as occurring at the same wall-clock time in every time zone.',
        },
        createdAt: {
          ...nullableTimestamp,
          description:
            'EventKit EKCalendarItem.creationDate as a UTC timestamp; NULL when EventKit has none.',
        },
        modifiedAt: {
          ...nullableTimestamp,
          description:
            'EventKit EKCalendarItem.lastModifiedDate as a UTC timestamp; NULL when EventKit has none.',
        },
        occurrenceAt: {
          ...nullableTimestamp,
          description:
            'EventKit EKEvent.occurrenceDate as a UTC timestamp: when this occurrence was originally scheduled, unchanged when it is detached and moved. NULL for a nonrecurring event.',
        },
        occurrenceDate: {
          ...nullableDate,
          description:
            'Local calendar date of EventKit EKEvent.occurrenceDate in the default time zone of the process that read it, set only for a recurring all-day event; NULL otherwise.',
        },
        detached: {
          ...boolean,
          description:
            'EventKit EKEvent.isDetached: an occurrence of a recurring series changed from what the series generates.',
        },
        status: {
          ...ordinal,
          description:
            'EventKit EKEvent.status raw value (EKEventStatus): 0 none, 1 confirmed, 2 tentative, 3 canceled. Apple documents only canceled as reliable. Unknown codes are kept as numbers.',
        },
        availability: {
          ...integer,
          description:
            'EventKit EKEvent.availability raw value (EKEventAvailability): -1 not supported by the calendar, 0 busy, 1 free, 2 tentative, 3 unavailable. Unknown codes are kept as numbers.',
        },
        birthdayContactId: {
          ...nullableText,
          description:
            'EventKit EKEvent.birthdayContactIdentifier, a Contacts framework contact identifier set only for events of the Birthdays calendar; NULL otherwise. Not verified to match identifiers of the Apple Contacts source.',
        },
        ...eventKitLocationFields('EKEvent.structuredLocation'),
      },
    },
    icsComponents: {
      description:
        'One source record per iCalendar component in the private EventKit ICS export of each native item with an occurrence in the event window: the VCALENDAR root, the VEVENT master, exception VEVENTs carrying RECURRENCE-ID, their alarms and any other exported component. Each item is exported once and whole, so a recurring series can describe occurrences outside the window. Grain is the native item (calendarId, calendarItemId), not an occurrence: eventId is set only for a nonrecurring VEVENT. Joining recurring components to events on (calendarId, calendarItemId) repeats them once per occurrence, so aggregate occurrences before joining. The ICS streams are read only when one is selected; on a macOS without the private export the read fails instead of loading no rows. Relationships name source streams, not destination tables.',
      properties: {
        id: {
          ...id,
          description:
            'JSON [calendarId, calendarItemId, path], where path lists child positions from the root VCALENDAR ("0", "0.1", …).',
        },
        ...icsItem,
        parentId: {
          ...nullableText,
          description:
            'Enclosing component; refers to icsComponents.id within this source. NULL for the root VCALENDAR.',
        },
        position: {
          ...ordinal,
          description:
            "Order among sibling components, numbered in content order: EventKit's export order changes between reads.",
        },
        name: {
          ...text,
          description:
            'Component name as exported, uppercased, such as VCALENDAR, VEVENT or VALARM.',
        },
        uid: {
          ...nullableText,
          description:
            "Raw value of the component's UID property; NULL when it has none.",
        },
        recurrenceId: {
          ...nullableText,
          description:
            "Raw, unparsed value of the component's RECURRENCE-ID property, which marks a component overriding one occurrence of a series; NULL when absent.",
        },
        recurrenceIdTimeZone: {
          ...nullableText,
          description:
            'First TZID parameter value of RECURRENCE-ID; NULL when RECURRENCE-ID is absent or has no TZID.',
        },
        eventId: {
          ...nullableText,
          description:
            'events.eventId of the nonrecurring event this VEVENT exactly describes: set only for a VEVENT without RECURRENCE-ID of an item that has no recurrence rules and is not detached. NULL for every other component, including all components of a recurring item, which relate at (calendarId, calendarItemId).',
        },
      },
    },
    icsProperties: {
      description:
        'One source record per property line of an icsComponents component, in export order, except DTSTAMP: EventKit sets it to the export time, so it is omitted. Values are raw iCalendar text; vendor X- properties are kept. ATTACH properties also appear in icsAttachments. Relationships name source streams, not destination tables.',
      properties: {
        id: {
          ...id,
          description:
            'JSON [calendarId, calendarItemId, path, position], extending the component path; icsParameters.propertyId and icsAttachments.propertyId refer to it.',
        },
        componentId: {
          ...id,
          description:
            'Owning component; refers to icsComponents.id within this source.',
        },
        ...icsItem,
        position: {
          ...ordinal,
          description:
            "Index among the component's properties in export order, counted after DTSTAMP is removed.",
        },
        name: {
          ...text,
          description:
            'Property name as exported, uppercased, including vendor X- names.',
        },
        value: {
          ...text,
          description:
            'Raw property value as exported after line unfolding: no TEXT unescaping, date parsing or decoding. An inline ATTACH value is a whole base64 file.',
        },
      },
    },
    icsAttachments: {
      description:
        'One source record per ATTACH property in the ICS export; the same property also remains in icsProperties with its parameters in icsParameters. File bytes can be inline (base64 in uri), remote (retrieved only by the attachment fetcher the app supplies) or unavailable: an attachment record exists even when no bytes are exported. Relationships name source streams, not destination tables.',
      properties: {
        id: {
          ...id,
          description: 'Same value as propertyId; the record key.',
        },
        propertyId: {
          ...id,
          description:
            'The ATTACH property; refers to icsProperties.id within this source.',
        },
        componentId: {
          ...id,
          description:
            'Component holding the ATTACH property; refers to icsComponents.id within this source.',
        },
        ...icsItem,
        uri: {
          ...text,
          description:
            'Raw ATTACH value: the base64 file content when inline is true, otherwise the attachment URI.',
        },
        filename: {
          ...nullableText,
          description:
            'First value of the ATTACH X-APPLE-FILENAME parameter, else of FILENAME; NULL when neither is present.',
        },
        formatType: {
          ...nullableText,
          description:
            'First value of the ATTACH FMTTYPE parameter, a media type; NULL when absent.',
        },
        inline: {
          ...boolean,
          description:
            'Whether ATTACH carries VALUE=BINARY or ENCODING=BASE64, so uri holds the file content itself rather than a location.',
        },
      },
    },
    icsParameters: {
      description:
        'One source record per value of each iCalendar property parameter: a comma-separated multi-value parameter yields one record per value. Relationships name source streams, not destination tables.',
      properties: {
        id: {
          ...id,
          description:
            'JSON [calendarId, calendarItemId, path, propertyPosition, position, valuePosition], extending the property id.',
        },
        propertyId: {
          ...id,
          description:
            'Owning property; refers to icsProperties.id within this source.',
        },
        componentId: {
          ...id,
          description:
            'Component of the owning property; refers to icsComponents.id within this source.',
        },
        ...icsItem,
        position: {
          ...ordinal,
          description:
            'Index of the parameter within its property, in export order.',
        },
        valuePosition: {
          ...ordinal,
          description: 'Index of this value within the parameter.',
        },
        name: {
          ...text,
          description: 'Parameter name as exported, uppercased.',
        },
        value: {
          ...text,
          description:
            "One parameter value, with surrounding double quotes removed and RFC 6868 caret escapes (^n, ^', ^^) decoded; otherwise as exported.",
        },
      },
    },
    attendees: {
      description: `One source record per participant of an event occurrence: its organizer and each attendee. ${perOccurrence} eventId refers to events.eventId. Relationships name source streams, not destination tables.`,
      properties: related.attendees,
    },
    alarms: {
      description: `One source record per EventKit alarm of an event occurrence. ${perOccurrence} eventId refers to events.eventId. Relationships name source streams, not destination tables.`,
      properties: related.alarms,
    },
    recurrenceRules: {
      description: `One source record per EventKit recurrence rule of a recurring event occurrence. ${perOccurrence} eventId refers to events.eventId; recurrenceRuleValues holds each rule's list values. Relationships name source streams, not destination tables.`,
      properties: related.recurrenceRules,
    },
    recurrenceRuleValues: {
      description: `One source record per entry of a recurrence rule's day, week, month or set-position lists. ${perOccurrence} ruleId refers to recurrenceRules.id and eventId to events.eventId. Relationships name source streams, not destination tables.`,
      properties: related.recurrenceRuleValues,
    },
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
