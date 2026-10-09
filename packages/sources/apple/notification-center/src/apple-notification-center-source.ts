import { setInterval } from 'node:timers/promises';

import {
  Catalog,
  type CopyConfiguration,
  type ExtractionCoverage,
  type FailureType,
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
  readonly identity: string;
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
    this.identity = `apple-notification-center:${path}`;
    Object.freeze(this);
  }

  protected override async open(): Promise<NotificationCenterScan> {
    return new NotificationCenterScan(this.#store.open(), this.scope);
  }

  override failureType(error: unknown): FailureType {
    return error instanceof NotificationCenterUnavailableError
      ? 'config'
      : 'system';
  }

  override coverage(_stream: Stream): ExtractionCoverage {
    return { ...localAppleStoreCoverage, selection: this.scope };
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
    let seen = version.current;
    yield streams;
    try {
      for await (const _ of setInterval(pollIntervalMs, undefined, {
        signal,
      })) {
        const current = version.current;
        if (current === seen) continue;
        seen = current;
        yield streams;
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) throw error;
    }
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    scan: NotificationCenterScan,
  ): AsyncGenerator<SourceMessage> {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === undefined)
      throw new Error(`Apple Notification Center has no stream ${stream.name}`);
    const records = reader.read(scan);
    yield* configuration.syncMode === 'incremental'
      ? diffSnapshot(stream, records, state)
      : records.map((data) => ({ stream: stream.name, data }));
  }
}
