import { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import type { Choice } from '@workspace/connector-apple-connector/choice';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import { AppleNotificationCenterSource } from '@workspace/source-apple-notification-center/apple-notification-center-source';

export default class NotificationCenterConnector extends AppleConnector {
  readonly datedBy = 'delivery date';
  readonly fullDiskAccess = true;
  // One store of every app's notifications; a date range is the only
  // narrowing.
  protected readonly choices: readonly Choice[] = [];
  // Reading the notifications opens the protected Notification Center store.
  protected override readonly probe = 'notifications';
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(): string {
    return 'No app needs to be open: macOS keeps every app’s notifications in one store while Notification Center holds them.';
  }

  protected source(scope: ImportScope) {
    return new AppleNotificationCenterSource(undefined, scope);
  }
}
