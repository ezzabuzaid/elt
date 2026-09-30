import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceWatchOptions,
  Stream,
} from 'elt';
import { diffSnapshot, Source, type SourceMessage, validateRecords } from 'elt';
import { EventKit, EventKitSnapshot } from '../../platform/macos/eventkit.ts';
import {
  eventKitAccountFields,
  eventKitCalendarFields,
  eventKitCatalog,
  eventKitFields,
  eventKitRelatedFields,
} from '../eventkit-schema.ts';
import type { ImportScope } from '../import-scope.ts';
import { localAppleStoreCoverage } from '../local-apple-store-coverage.ts';
import { dateComponentNames, reminderRows } from './reminder-rows.ts';

const { id, text, nullableText, nullableTimestamp, integer, boolean } =
  eventKitFields;

const related = eventKitRelatedFields('reminderId');

const catalog = eventKitCatalog(
  {
    accounts: {
      description:
        "One source record per EventKit account (EKSource) in this Mac's store, including accounts without reminder lists. An import scope keeps the selected accounts; a list scope also drops accounts owning no selected list. Relationships name source streams, not destination tables.",
      properties: eventKitAccountFields,
    },
    lists: {
      description:
        'One source record per reminder list (an EventKit calendar for reminders) visible on this Mac. An import scope keeps only the selected lists. accountId refers to accounts.id; reminders.listId refers to id. Relationships name source streams, not destination tables.',
      properties: eventKitCalendarFields,
    },
    reminders: {
      description:
        'One source record per reminder visible through EventKit on this Mac, completed reminders included, limited to the selected lists when an import scope is set. No date filter. Start and due dates live in dateComponents as native component sets; no UTC due timestamp is derived. dateComponents, attendees, alarms, recurrenceRules and recurrenceRuleValues refer to id through reminderId; listId refers to lists.id. Relationships name source streams, not destination tables.',
      properties: {
        id: {
          ...id,
          description:
            'EventKit EKCalendarItem.calendarItemIdentifier; related streams refer to it through reminderId. Apple documents that a full sync can replace it.',
        },
        listId: {
          ...id,
          description:
            'EventKit EKCalendarItem.calendar.calendarIdentifier: the owning list; refers to lists.id within this source.',
        },
        externalId: {
          ...nullableText,
          description:
            'EventKit EKCalendarItem.calendarItemExternalIdentifier, the server-provided identifier; NULL when EventKit has none. Apple documents duplicates across calendars and, for Exchange reminders, different values between devices, so it is not unique.',
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
        timeZone: {
          ...nullableText,
          description:
            'EventKit EKCalendarItem.timeZone identifier; NULL when EventKit has none, which Apple documents as floating. The start and due component sets carry their own time zones in dateComponents.',
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
        completed: {
          ...boolean,
          description: 'EventKit EKReminder.isCompleted.',
        },
        completedAt: {
          ...nullableTimestamp,
          description:
            'EventKit EKReminder.completionDate as a UTC timestamp; NULL when EventKit has none.',
        },
        priority: {
          ...integer,
          minimum: 0,
          maximum: 9,
          description:
            'EventKit EKReminder.priority: 0 no priority, 1 highest through 9 lowest. Apple follows RFC 5545 (1 to 4 high, 5 medium, 6 to 9 low); its EKReminderPriority constants are 1 high, 5 medium and 9 low.',
        },
      },
    },
    dateComponents: {
      description:
        "One source record per start or due date a reminder sets; a reminder without that date has no record. Each record keeps EventKit's NSDateComponents set whole: calendar, time zone, leap month and every component, with a missing component NULL and no manufactured UTC timestamp. A date without a time has NULL hour, minute and second. reminderId refers to reminders.id. Relationships name source streams, not destination tables.",
      properties: {
        id: {
          ...id,
          description: 'JSON [reminderId, kind]; unique within this stream.',
        },
        reminderId: {
          ...id,
          description:
            'Owning reminder; refers to reminders.id within this source.',
        },
        kind: {
          ...text,
          enum: ['start', 'due'],
          description:
            'start for EventKit EKReminder.startDateComponents, due for EKReminder.dueDateComponents.',
        },
        calendarIdentifier: {
          ...nullableText,
          description:
            'Identifier of the NSDateComponents calendar, the calendar system the components count in; NULL when the set has no calendar.',
        },
        timeZone: {
          ...nullableText,
          description:
            'NSDateComponents.timeZone identifier; NULL for a floating date, which Apple documents as a nil time zone.',
        },
        ...Object.fromEntries(
          dateComponentNames.map((name) => [
            name,
            {
              type: ['integer', 'null'],
              description: `NSDateComponents.${name}; NULL when the set leaves it undefined or this macOS does not provide it.`,
            },
          ]),
        ),
        leapMonth: {
          ...boolean,
          description:
            "NSDateComponents.isLeapMonth: whether month is a leap month in the set's calendar.",
        },
        repeatedDay: {
          type: ['boolean', 'null'],
          description:
            'NSDateComponents.isRepeatedDay; NULL where this macOS does not provide it.',
        },
      },
    },
    attendees: {
      description:
        'One source record per attendee EventKit lists for a reminder. reminderId refers to reminders.id. Relationships name source streams, not destination tables.',
      properties: related.attendees,
    },
    alarms: {
      description:
        'One source record per EventKit alarm of a reminder, whether it fires at a time or at a location. reminderId refers to reminders.id. Relationships name source streams, not destination tables.',
      properties: related.alarms,
    },
    recurrenceRules: {
      description:
        "One source record per EventKit recurrence rule of a reminder. reminderId refers to reminders.id; recurrenceRuleValues holds each rule's list values. Relationships name source streams, not destination tables.",
      properties: related.recurrenceRules,
    },
    recurrenceRuleValues: {
      description:
        "One source record per entry of a recurrence rule's day, week, month or set-position lists. ruleId refers to recurrenceRules.id and reminderId to reminders.id. Relationships name source streams, not destination tables.",
      properties: related.recurrenceRuleValues,
    },
  },
  { snapshot: true },
);

// Adapter: native EventKit records enter the existing Source/Copy/Pipeline contract.
export class AppleRemindersSource extends Source<EventKitSnapshot> {
  readonly #eventKit = new EventKit('reminders');
  readonly identity = 'apple-reminders:eventkit';
  protected readonly catalog = catalog;
  readonly accounts = catalog.get('accounts');
  readonly lists = catalog.get('lists');
  readonly reminders = catalog.get('reminders');
  readonly dateComponents = catalog.get('dateComponents');
  readonly attendees = catalog.get('attendees');
  readonly alarms = catalog.get('alarms');
  readonly recurrenceRules = catalog.get('recurrenceRules');
  readonly recurrenceRuleValues = catalog.get('recurrenceRuleValues');

  constructor(readonly scope: ImportScope = {}) {
    super();
    Object.freeze(this);
  }

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    for await (const _ of this.#eventKit.watch(signal)) yield streams;
  }

  // Every selected stream from one change-free read, so reminders match
  // their lists and alarms their reminders.
  protected override async open(
    streams: readonly Stream[],
  ): Promise<EventKitSnapshot> {
    const { accountIds, collectionIds } = this.scope;
    return new EventKitSnapshot(
      await this.#eventKit.consistently(async () => {
        const rows = reminderRows(
          await this.#eventKit.read({ accountIds, collectionIds }),
          this.scope,
        );
        return new Map(
          streams.map((stream) => [
            stream.name,
            validateRecords(stream, rows.get(stream.name), 'EventKit'),
          ]),
        );
      }),
    );
  }

  protected override async *extract(
    { stream, syncMode }: CopyConfiguration,
    state: unknown,
    _partition: null,
    snapshot: EventKitSnapshot,
  ): AsyncGenerator<SourceMessage> {
    const records = snapshot.of(stream.name);
    if (syncMode === 'incremental') yield* diffSnapshot(stream, records, state);
    else for (const data of records) yield { stream: stream.name, data };
  }
}
