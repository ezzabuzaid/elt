import type {
  Notification,
  NotificationApp,
  NotificationCategory,
  NotificationCenterSnapshot,
} from '@workspace/sdk-apple-notification-center';
import {
  type ImportScope,
  withinDates,
} from '@workspace/source-apple-macos/import-scope';

// A delivery time cut to the millisecond, the precision of an import's dates,
// so it compares with them as text: cutting keeps every notification on the
// same side of a millisecond boundary, where a longer fraction would sort
// before it.
const toMilliseconds = (instant: string) => `${instant.slice(0, 23)}Z`;

// One run's read of Notification Center's store: every stream reads the same
// snapshot, each kind of record is read from it once, and the import scope's
// dates keep the notifications delivered within them. Apps and categories
// have no date to fall outside, so they stay.
export class NotificationCenterScan implements AsyncDisposable {
  readonly #snapshot: NotificationCenterSnapshot;
  readonly #scope: ImportScope;
  #notifications?: Notification[];
  #apps?: NotificationApp[];
  #categories?: NotificationCategory[];

  constructor(snapshot: NotificationCenterSnapshot, scope: ImportScope) {
    this.#snapshot = snapshot;
    this.#scope = scope;
  }

  get notifications(): readonly Notification[] {
    this.#notifications ??= this.#snapshot
      .notifications()
      .filter(({ deliveredAt }) =>
        withinDates(this.#scope, toMilliseconds(deliveredAt)),
      );
    return this.#notifications;
  }

  get apps(): readonly NotificationApp[] {
    this.#apps ??= this.#snapshot.apps();
    return this.#apps;
  }

  get categories(): readonly NotificationCategory[] {
    this.#categories ??= this.#snapshot.categories();
    return this.#categories;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#snapshot[Symbol.dispose]();
  }
}
