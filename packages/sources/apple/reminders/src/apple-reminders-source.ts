import type {
  CopyConfiguration,
  ExtractionCoverage,
  FailureType,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Catalog, Source, diffSnapshot } from '@workspace/elt';
import type { RemindersStore } from '@workspace/sdk-apple-eventkit';
import { RemindersUnavailableError } from '@workspace/sdk-apple-eventkit';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import { localAppleStoreCoverage } from '@workspace/source-apple-macos/local-apple-store-coverage';

import type { RemindersReader } from './apple-reminders-stream.ts';
import { RemindersScan } from './reminders-scan.ts';
import { AccountsStream } from './streams/accounts-stream.ts';
import { AlarmsStream } from './streams/alarms-stream.ts';
import { AttendeesStream } from './streams/attendees-stream.ts';
import { DateComponentsStream } from './streams/date-components-stream.ts';
import { ListsStream } from './streams/lists-stream.ts';
import { RecurrenceRuleValuesStream } from './streams/recurrence-rule-values-stream.ts';
import { RecurrenceRulesStream } from './streams/recurrence-rules-stream.ts';
import { RemindersStream } from './streams/reminders-stream.ts';

const readers = {
  accounts: new AccountsStream(),
  lists: new ListsStream(),
  reminders: new RemindersStream(),
  dateComponents: new DateComponentsStream(),
  attendees: new AttendeesStream(),
  alarms: new AlarmsStream(),
  recurrenceRules: new RecurrenceRulesStream(),
  recurrenceRuleValues: new RecurrenceRuleValuesStream(),
} satisfies Record<string, RemindersReader>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);
const readersByName = new Map<string, RemindersReader>(
  Object.values(readers).map((reader) => [reader.name, reader]),
);

// Adapter: native EventKit records enter the existing Source/Copy/Pipeline contract.
export class AppleRemindersSource extends Source<RemindersScan> {
  readonly #store: RemindersStore;
  readonly identity = 'apple-reminders:eventkit';
  protected readonly catalog = catalog;
  readonly accounts = readers.accounts.describe();
  readonly lists = readers.lists.describe();
  readonly reminders = readers.reminders.describe();
  readonly dateComponents = readers.dateComponents.describe();
  readonly attendees = readers.attendees.describe();
  readonly alarms = readers.alarms.describe();
  readonly recurrenceRules = readers.recurrenceRules.describe();
  readonly recurrenceRuleValues = readers.recurrenceRuleValues.describe();

  readonly scope: ImportScope;

  constructor({
    store,
    scope = {},
  }: {
    store: RemindersStore;
    scope?: ImportScope;
  }) {
    super();
    this.#store = store;
    this.scope = scope;
    Object.freeze(this);
  }

  override failureType(error: unknown): FailureType {
    return error instanceof RemindersUnavailableError ? 'config' : 'system';
  }

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    for await (const _ of this.#store.watch(signal)) yield streams;
  }

  // One change-free read for every selected stream, so reminders match their
  // lists and alarms their reminders.
  protected override async open(): Promise<RemindersScan> {
    return new RemindersScan(
      await this.#store.read({
        accountIds: this.scope.accountIds,
        calendarIds: this.scope.collectionIds,
      }),
    );
  }

  protected override async *extract(
    { stream, syncMode }: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: RemindersScan,
  ): AsyncGenerator<SourceMessage> {
    const reader = readersByName.get(stream.name);
    if (reader === undefined)
      throw new Error(`Apple Reminders has no stream ${stream.name}`);
    const records = reader.read(scan);
    if (syncMode === 'incremental') yield* diffSnapshot(stream, records, state);
    else for (const data of records) yield { stream: stream.name, data };
  }
}
