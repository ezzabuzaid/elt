import { plistJSON } from '@workspace/codec-plist';
import type { RecordDraft } from '@workspace/elt';
import type { Notification } from '@workspace/sdk-apple-notification-center';

import {
  AppleNotificationCenterStream,
  notificationCenterFields,
} from '../apple-notification-center-stream.ts';
import type { NotificationCenterScan } from '../notification-center-scan.ts';

const { id, text, nullableInteger, nullableText, instant, nullableInstant } =
  notificationCenterFields;

const properties = {
  id: {
    ...id,
    description:
      'The delivery’s UUID (record.uuid), uppercase as NSUUID writes it; Activity’s notificationUsage.notificationId names a notification by it.',
  },
  bundleId: {
    ...text,
    description:
      'Bundle identifier of the app that posted it, in the app’s own case; apps.bundleId is the same identifier lowercased.',
  },
  deliveredAt: {
    ...instant,
    description: 'When Notification Center delivered it, to the microsecond.',
  },
  requestId: {
    ...nullableText,
    description:
      'The identifier the app gave the request (req.iden); Activity’s notificationDeliveries.requestId. An app that posts again under it replaces this notification with a new one. NULL for notifications posted through the legacy API.',
  },
  threadId: {
    ...nullableText,
    description:
      'The thread the app groups it under (req.thre), such as a chat or a conversation; NULL when it set none.',
  },
  category: {
    ...nullableText,
    description:
      'The category the app gave it (req.cate); refers to categories.id for the same app. NULL when it set none.',
  },
  title: { ...nullableText, description: 'Its title (req.titl).' },
  subtitle: { ...nullableText, description: 'Its subtitle (req.subt).' },
  body: { ...nullableText, description: 'Its text (req.body).' },
  defaultActionUrl: {
    ...nullableText,
    description:
      'The URL clicking it opens (req.durl), such as a messages:// link to the message; NULL when the app handles the click itself.',
  },
  soundName: {
    ...nullableText,
    description:
      'The sound it played (req.soun); NULL when it played the default sound or none.',
  },
  expiresAt: {
    ...nullableInstant,
    description:
      'When usernoted removes it (req.edat), such as when a calendar event ends; NULL when it does not expire.',
  },
  interruptionLevel: {
    type: ['string', 'null'],
    enum: ['passive', 'active', 'timeSensitive', 'critical'],
    description:
      'Its UNNotificationInterruptionLevel (req.intrp); NULL when the app left the default.',
  },
  contentType: {
    ...nullableText,
    description:
      'The kind of communication it declares (req.unct), such as UNNotificationContentTypeMessagingDirect; NULL for an ordinary notification.',
  },
  style: {
    ...nullableInteger,
    description:
      'usernoted’s code for how it is shown (record.style), 0 or 1 on macOS 27; Apple does not document the codes. NULL when not stored.',
  },
  userInfo: {
    ...nullableText,
    description:
      'The app’s own payload (req.usda) as JSON, naming the record it is about in the app’s store: a Messages message GUID, a Mail message ID, a Calendar event, a Codex conversation_id. NULL when the app sent none.',
  },
  payload: {
    ...text,
    description:
      'Everything usernoted stores for the notification (record.data) as JSON, nested archives decoded, data as Base64: the fields above under their stored keys, and the ones this source does not name.',
  },
} as const;

// Notification Center holds a notification only until its app withdraws it,
// the user clears it, a newer one replaces it or it expires, and records none
// of these, so a notification gone from the store was forgotten: its row stays.
export class NotificationsStream extends AppleNotificationCenterStream<
  typeof properties,
  Notification
> {
  readonly name = 'notifications';
  readonly primaryKey = ['id'];
  readonly emitsDeletes = undefined;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per notification Notification Center delivered while an import read its store. Primary key id. Notification Center keeps a notification for minutes to days; a notification it no longer holds stays loaded, so rows are a history, not what Notification Center shows now.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: NotificationCenterScan): readonly Notification[] {
    return scan.notifications;
  }

  protected records(
    notification: Notification,
  ): RecordDraft<typeof properties>[] {
    return [
      {
        id: notification.id,
        bundleId: notification.bundleId,
        deliveredAt: notification.deliveredAt,
        requestId: notification.requestId,
        threadId: notification.threadId,
        category: notification.category,
        title: notification.title,
        subtitle: notification.subtitle,
        body: notification.body,
        defaultActionUrl: notification.defaultActionUrl,
        soundName: notification.soundName,
        expiresAt: notification.expiresAt,
        interruptionLevel: notification.interruptionLevel,
        contentType: notification.contentType,
        style: notification.style,
        userInfo:
          notification.userInfo === null
            ? null
            : plistJSON(notification.userInfo),
        payload: plistJSON(notification.payload),
      },
    ];
  }
}
