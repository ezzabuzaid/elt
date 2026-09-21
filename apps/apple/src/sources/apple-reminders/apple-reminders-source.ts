import type {
  Catalog,
  CopyConfiguration,
  SourceWatchOptions,
  Stream,
} from 'elt';
import { type RecordMessage, Source } from 'elt';
import { EventKit } from '../../platform/macos/eventkit.ts';
import {
  eventKitAccountFields,
  eventKitCalendarFields,
  eventKitCatalog,
  eventKitFields,
  eventKitRelatedFields,
  validateEventKitRecords,
} from '../eventkit-schema.ts';
import { dateComponentNames, remindersScript } from './reminders-script.ts';

const { id, text, nullableText, nullableTimestamp, integer, boolean } =
  eventKitFields;

const catalog = eventKitCatalog({
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
});

// Adapter: native EventKit records enter the existing Source/Copy/Pipeline contract.
export class AppleRemindersSource extends Source {
  readonly #eventKit = new EventKit('reminders');
  readonly identity = 'apple-reminders:eventkit';
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

  async discover(): Promise<Catalog> {
    return catalog;
  }

  override async *watch({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    for (const stream of streams) catalog.get(stream.name);
    for await (const _ of this.#eventKit.watch(signal)) yield streams;
  }

  validate(configuration: CopyConfiguration): void {
    const stream = catalog.get(configuration.stream.name);
    if (configuration.stream !== stream)
      throw new TypeError(
        'Reminders requires a stream from its discovered catalog',
      );
    configuration.validate(stream);
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    _state: unknown,
  ): AsyncGenerator<RecordMessage> {
    const stream = catalog.get(configuration.stream.name);
    const records = validateEventKitRecords(
      stream,
      await this.#eventKit.execute(`
        ${remindersScript}
        return readReminders(store, ${JSON.stringify(stream.name)});
      `),
    );
    for (const data of records) yield { stream: stream.name, data };
  }
}
