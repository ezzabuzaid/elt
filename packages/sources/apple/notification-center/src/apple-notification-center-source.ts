import { pollChanges } from '@zukhruf/async';
import { ClosedWorld } from '@zukhruf/snapshot-differential';

import {
  Catalog,
  type CopyConfiguration,
  type ExtractionCoverage,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  type Stream,
  diffSnapshot,
} from '@workspace/elt';
import {
  NotificationCenterStore,
  NotificationCenterUnavailableError,
  notificationCenterStorePath,
} from '@workspace/sdk-apple-notification-center';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import { localAppleStoreCoverage } from '@workspace/source-apple-macos/local-apple-store-coverage';

import type { NotificationCenterReader } from './apple-notification-center-stream.ts';
import { NotificationCenterScan } from './notification-center-scan.ts';
import { AppsStream } from './streams/apps-stream.ts';
import { CategoriesStream } from './streams/categories-stream.ts';
import { CategoryActionsStream } from './streams/category-actions-stream.ts';
import { NotificationsStream } from './streams/notifications-stream.ts';

const readers = {
  notifications: new NotificationsStream(),
  apps: new AppsStream(),
  categories: new CategoriesStream(),
  categoryActions: new CategoryActionsStream(),
} satisfies Record<string, NotificationCenterReader>;
const catalog = new Catalog(
  Object.values(readers).map((reader) => reader.describe()),
);
const readersByName = new Map<string, NotificationCenterReader>(
  Object.values(readers).map((reader) => [reader.name, reader]),
);
// How often a watch checks the store for commits.
const pollIntervalMs = 1000;

// Reads this Mac's Notification Center, the store usernoted keeps, without
// Notification Center or the UserNotifications framework.
export class AppleNotificationCenterSource extends Source<NotificationCenterScan> {
  readonly identity = 'apple-notification-center';
  protected readonly catalog = catalog;
  readonly notifications = readers.notifications.describe();
  readonly apps = readers.apps.describe();
  readonly categories = readers.categories.describe();
  readonly categoryActions = readers.categoryActions.describe();

  readonly path: string;
  readonly scope: ImportScope;
  readonly #store: NotificationCenterStore;

  constructor(path = notificationCenterStorePath, scope: ImportScope = {}) {
    super();
    this.path = path;
    this.scope = scope;
    this.#store = new NotificationCenterStore(path);
    Object.freeze(this);
  }

  protected override async open(): Promise<NotificationCenterScan> {
    return new NotificationCenterScan(this.#store.open(), this.scope);
  }

  protected override readonly configErrors = [
    NotificationCenterUnavailableError,
  ];

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }

  override async currentAsOf() {
    return null;
  }

  // One database whose data_version cannot say which table a commit touched,
  // so each commit wakes every selected stream; the snapshot diff writes
  // nothing for the ones that did not change.
  protected override async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    if (signal.aborted) return;
    using version = this.#store.version();
    for await (const changed of pollChanges(
      new Map([['version', async () => version.current]]),
      { interval: pollIntervalMs, signal },
    ))
      yield changed.size > 0 ? streams : [];
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: NotificationCenterScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === undefined)
      throw new Error(`Apple Notification Center has no stream ${stream.name}`);
    const records = reader.read(scan);
    yield* diffSnapshot(
      configuration,
      records,
      state,
      stream.emitsDeletes ? { policy: new ClosedWorld(), signal } : { signal },
    );
  }
}
