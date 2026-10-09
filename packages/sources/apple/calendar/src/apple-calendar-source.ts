import { mkdtempDisposable, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CopyConfiguration,
  ExtractionCoverage,
  FailureType,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Catalog, Source, diffSnapshot, isTimestamp } from '@workspace/elt';
import {
  type CalendarStore,
  CalendarUnavailableError,
  IcsExportUnavailableError,
} from '@workspace/sdk-apple-eventkit';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import { CalendarScan } from './calendar-scan.ts';
import type { CalendarReader } from './calendar-stream.ts';
import { AccountsStream } from './streams/accounts-stream.ts';
import { AlarmsStream } from './streams/alarms-stream.ts';
import { AttendeesStream } from './streams/attendees-stream.ts';
import { CalendarsStream } from './streams/calendars-stream.ts';
import { EventsStream } from './streams/events-stream.ts';
import { IcsAttachmentsStream } from './streams/ics-attachments-stream.ts';
import { IcsComponentsStream } from './streams/ics-components-stream.ts';
import { IcsParametersStream } from './streams/ics-parameters-stream.ts';
import { IcsPropertiesStream } from './streams/ics-properties-stream.ts';
import { RecurrenceRuleValuesStream } from './streams/recurrence-rule-values-stream.ts';
import { RecurrenceRulesStream } from './streams/recurrence-rules-stream.ts';

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

const readers = {
  accounts: new AccountsStream(),
  calendars: new CalendarsStream(),
  events: new EventsStream(),
  icsComponents: new IcsComponentsStream(),
  icsProperties: new IcsPropertiesStream(),
  icsAttachments: new IcsAttachmentsStream(),
  icsParameters: new IcsParametersStream(),
  attendees: new AttendeesStream(),
  alarms: new AlarmsStream(),
  recurrenceRules: new RecurrenceRulesStream(),
  recurrenceRuleValues: new RecurrenceRuleValuesStream(),
} satisfies Record<string, CalendarReader>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);
const readersByName = new Map<string, CalendarReader>(
  Object.values(readers).map((reader) => [reader.name, reader]),
);
const readerOf = (stream: Stream): CalendarReader => {
  const reader = readersByName.get(stream.name);
  if (reader === undefined)
    throw new Error(`Apple Calendar has no stream ${stream.name}`);
  return reader;
};

export class AppleCalendarSource extends Source<CalendarScan> {
  readonly #store: CalendarStore;
  // The window is not part of the identity: moving it keeps one checkpoint, and
  // incremental copies delete the occurrences that left it.
  readonly identity = 'apple-calendar:eventkit';
  protected readonly catalog = catalog;
  readonly startAt: string;
  readonly endAt: string;
  readonly scope: ImportScope;
  readonly accounts = readers.accounts.describe();
  readonly calendars = readers.calendars.describe();
  readonly events = readers.events.describe();
  readonly attendees = readers.attendees.describe();
  readonly alarms = readers.alarms.describe();
  readonly recurrenceRules = readers.recurrenceRules.describe();
  readonly recurrenceRuleValues = readers.recurrenceRuleValues.describe();
  readonly icsComponents = readers.icsComponents.describe();
  readonly icsProperties = readers.icsProperties.describe();
  readonly icsParameters = readers.icsParameters.describe();
  readonly icsAttachments = readers.icsAttachments.describe();

  readonly #attachments?: CalendarAttachmentFetcher;

  constructor({
    store,
    startAt,
    endAt,
    attachments,
    scope = {},
  }: {
    store: CalendarStore;
    startAt: string;
    endAt: string;
    // Retrieves remote ATTACH files; only needed when a copy reads their bytes.
    attachments?: CalendarAttachmentFetcher;
    scope?: ImportScope;
  }) {
    super();
    this.#store = store;
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

  override failureType(error: unknown): FailureType {
    return error instanceof CalendarUnavailableError ? 'config' : 'system';
  }

  override coverage(stream: Stream): ExtractionCoverage {
    if (!readerOf(stream).dated)
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
    for await (const _ of this.#store.watch(signal)) yield streams;
  }

  // Every selected stream reads from one change-free EventKit read, so
  // occurrences match their calendars and ICS rows their items. The private
  // ICS export is asked for only when an ICS stream is selected.
  protected override async open(
    streams: readonly Stream[],
  ): Promise<CalendarScan> {
    try {
      const contents = await this.#store.read({
        startAt: this.startAt,
        endAt: this.endAt,
        ics: streams.some((stream) => readerOf(stream).requiresIcs),
        accountIds: this.scope.accountIds,
        calendarIds: this.scope.collectionIds,
      });
      return new CalendarScan(contents, this.#attachments);
    } catch (error) {
      if (error instanceof IcsExportUnavailableError)
        throw new CalendarIcsUnavailableError(error);
      throw error;
    }
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: CalendarScan,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readerOf(stream);
    const records = await reader.read(scan);
    const messages =
      configuration.syncMode === 'incremental'
        ? diffSnapshot(stream, records, state)
        : records.map((data) => ({ stream: stream.name, data }));
    if (configuration.fileReads.length === 0) {
      yield* messages;
      return;
    }
    // Only records the diff emits are staged, one at a time.
    await using staging = await mkdtempDisposable(
      join(tmpdir(), 'context-compiler-calendar-attachment-'),
    );
    for await (const message of messages) {
      if ('type' in message) {
        yield message;
        continue;
      }
      const file = await reader.file(message.data, scan, staging.path);
      yield { ...message, file };
      if (file !== null) await rm(file, { force: true });
    }
  }
}
