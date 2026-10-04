import type {
  CopyConfiguration,
  ExtractionCoverage,
  SourceMessage,
  SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { Source, diffSnapshot, validateRecords } from '@workspace/elt';
import type { RemindersStore } from '@workspace/macos-eventkit';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import { localAppleStoreCoverage } from '@workspace/source-apple-macos/local-apple-store-coverage';

import { reminderRows } from './reminder-rows.ts';
import { catalog } from './reminders-catalog.ts';
import { RemindersSnapshot } from './reminders-snapshot.ts';

// Adapter: native EventKit records enter the existing Source/Copy/Pipeline contract.
export class AppleRemindersSource extends Source<RemindersSnapshot> {
  readonly #store: RemindersStore;
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

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    for await (const _ of this.#store.watch(signal)) yield streams;
  }

  // Every selected stream from one change-free read, so reminders match
  // their lists and alarms their reminders.
  protected override async open(
    streams: readonly Stream[],
  ): Promise<RemindersSnapshot> {
    const rows = reminderRows(
      await this.#store.read({
        accountIds: this.scope.accountIds,
        calendarIds: this.scope.collectionIds,
      }),
    );
    return new RemindersSnapshot(
      new Map(
        streams.map((stream) => [
          stream.name,
          validateRecords(stream, rows.get(stream.name), 'EventKit'),
        ]),
      ),
    );
  }

  protected override async *extract(
    { stream, syncMode }: CopyConfiguration,
    state: unknown,
    _partition: null,
    snapshot: RemindersSnapshot,
  ): AsyncGenerator<SourceMessage> {
    const records = snapshot.of(stream.name);
    if (syncMode === 'incremental') yield* diffSnapshot(stream, records, state);
    else for (const data of records) yield { stream: stream.name, data };
  }
}
