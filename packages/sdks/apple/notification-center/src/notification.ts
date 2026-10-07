import type { PlistValue } from '@workspace/codec-plist';

// UNNotificationInterruptionLevel, whose raw values usernoted stores.
export type InterruptionLevel =
  'passive' | 'active' | 'timeSensitive' | 'critical';

export const interruptionLevels: readonly InterruptionLevel[] = [
  'passive',
  'active',
  'timeSensitive',
  'critical',
];

// One notification Notification Center holds, as its app posted it.
export type Notification = {
  // The delivery's UUID, as NSUUID writes it; Biome's Notification.Usage
  // names a notification by it.
  readonly id: string;
  // The posting app's bundle identifier, in its own case.
  readonly bundleId: string;
  readonly deliveredAt: string;
  // The identifier the app gave the request; legacy notifications have none.
  readonly requestId: string | null;
  readonly threadId: string | null;
  readonly category: string | null;
  readonly title: string | null;
  readonly subtitle: string | null;
  readonly body: string | null;
  readonly defaultActionUrl: string | null;
  readonly soundName: string | null;
  readonly expiresAt: string | null;
  readonly interruptionLevel: InterruptionLevel | null;
  // The content type a communication notification declares, such as
  // UNNotificationContentTypeMessagingDirect.
  readonly contentType: string | null;
  // usernoted's code for how the notification is shown.
  readonly style: number | null;
  // The app's own payload, which names the record it is about in the app's
  // store (a Messages GUID, a Mail message ID, a Codex conversation).
  readonly userInfo: PlistValue | null;
  // Everything usernoted stores for the notification, archives decoded.
  readonly payload: PlistValue;
};

// An app that has posted to Notification Center.
export type NotificationApp = {
  // As usernoted keys it: lowercased.
  readonly bundleId: string;
  readonly badge: number | null;
};

// A button a category puts on its notifications. Each text is the one the app
// registered, or its localization key when the app registered it localized:
// usernoted keeps the key, and the app's bundle resolves it.
export type CategoryAction = {
  readonly position: number;
  readonly id: string;
  readonly title: string | null;
  // UNNotificationActionOptions.
  readonly options: number | null;
  // usernoted's code for the kind of action; 1 on text-input actions.
  readonly typeCode: number | null;
  readonly textInputButtonTitle: string | null;
  readonly textInputPlaceholder: string | null;
};

// A notification category an app registered, kept in the order it gave them:
// nothing stops an app registering one identifier twice.
export type NotificationCategory = {
  readonly bundleId: string;
  readonly position: number;
  readonly id: string;
  // UNNotificationCategoryOptions.
  readonly options: number | null;
  readonly intentIdentifiers: readonly string[] | null;
  readonly hiddenPreviewsBodyPlaceholder: string | null;
  readonly summaryFormat: string | null;
  readonly actionsMenuTitle: string | null;
  readonly actions: readonly CategoryAction[];
};
