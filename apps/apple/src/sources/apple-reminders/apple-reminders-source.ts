import type { CopyConfiguration, SourceWatchOptions, Stream } from 'elt';
import { diffSnapshot, Source, type SourceMessage, validateRecords } from 'elt';
import { EventKit, EventKitSnapshot } from '../../platform/macos/eventkit.ts';
import {
  eventKitAccountFields,
  eventKitCalendarFields,
  eventKitCatalog,
  eventKitFields,
  eventKitRelatedFields,
} from '../eventkit-schema.ts';
import { dateComponentNames, remindersScript } from './reminders-script.ts';

const { id, text, nullableText, nullableTimestamp, integer, boolean } =
  eventKitFields;

const catalog = eventKitCatalog(
  {
    accounts: eventKitAccountFields,
    lists: eventKitCalendarFields,
    reminders: {
      id,
      listId: id,
      externalId: nullableText,
      name: text,
      body: nullableText,
      location: nullableText,
      url: nullableText,
      timeZone: nullableText,
      createdAt: nullableTimestamp,
      modifiedAt: nullableTimestamp,
      completed: boolean,
      completedAt: nullableTimestamp,
      priority: { ...integer, minimum: 0, maximum: 9 },
    },
    dateComponents: {
      id,
      reminderId: id,
      kind: { ...text, enum: ['start', 'due'] },
      calendarIdentifier: nullableText,
      timeZone: nullableText,
      ...Object.fromEntries(
        dateComponentNames.map((name) => [name, { type: ['integer', 'null'] }]),
      ),
      leapMonth: boolean,
      repeatedDay: { type: ['boolean', 'null'] },
    },
    ...eventKitRelatedFields('reminderId'),
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

  constructor() {
    super();
    Object.freeze(this);
  }

  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    for await (const _ of this.#eventKit.watch(signal)) yield streams;
  }

  // Every selected stream from one change-free window, so reminders match
  // their lists and alarms their reminders.
  protected override async open(
    streams: readonly Stream[],
  ): Promise<EventKitSnapshot> {
    return new EventKitSnapshot(
      await this.#eventKit.consistently(async () => {
        const records = new Map<string, Record<string, unknown>[]>();
        for (const stream of streams)
          records.set(
            stream.name,
            validateRecords(
              stream,
              await this.#eventKit.execute(`
                ${remindersScript}
                return readReminders(store, ${JSON.stringify(stream.name)});
              `),
              'EventKit',
            ),
          );
        return records;
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
