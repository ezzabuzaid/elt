import type { RecordDraft } from '@workspace/elt';
import type { NotificationCategory } from '@workspace/sdk-apple-notification-center';

import {
  AppleNotificationCenterStream,
  notificationCenterFields,
} from '../apple-notification-center-stream.ts';
import type { NotificationCenterScan } from '../notification-center-scan.ts';

const { id, ordinal, nullableInteger, nullableText, nullableTextList } =
  notificationCenterFields;

const properties = {
  bundleId: {
    ...id,
    description: 'The app that registered it; refers to apps.bundleId.',
  },
  position: {
    ...ordinal,
    description:
      'Its place in the list the app registered, from 0; an app can register one identifier twice, so the position, not the identifier, tells them apart.',
  },
  id: {
    ...id,
    description:
      'The category identifier (id) that notifications.category names.',
  },
  options: {
    ...nullableInteger,
    description: 'Its UNNotificationCategoryOptions bits (opt).',
  },
  intentIdentifiers: {
    ...nullableTextList,
    description:
      'The SiriKit intents its notifications relate to (ints); NULL when it names none.',
  },
  hiddenPreviewsBodyPlaceholder: {
    ...nullableText,
    description:
      'The text shown instead of the body when previews are hidden (hidb), or its localization key; NULL when the app set none.',
  },
  summaryFormat: {
    ...nullableText,
    description:
      'The format of the summary of a group of its notifications (sumf), or its localization key; NULL when the app set none.',
  },
  actionsMenuTitle: {
    ...nullableText,
    description:
      'The title of its actions menu (atit), or its localization key; NULL when the app set none.',
  },
} as const;

export class CategoriesStream extends AppleNotificationCenterStream<
  typeof properties,
  NotificationCategory
> {
  readonly name = 'categories';
  readonly primaryKey = ['bundleId', 'position'];
  readonly emitsDeletes = true;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per notification category an app registered, the kinds of notification it posts and the buttons they carry (categoryActions). Primary key bundleId, position. A category the app stops registering is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(
    scan: NotificationCenterScan,
  ): readonly NotificationCategory[] {
    return scan.categories;
  }

  protected records(
    category: NotificationCategory,
  ): RecordDraft<typeof properties>[] {
    return [
      {
        bundleId: category.bundleId,
        position: category.position,
        id: category.id,
        options: category.options,
        intentIdentifiers: category.intentIdentifiers,
        hiddenPreviewsBodyPlaceholder: category.hiddenPreviewsBodyPlaceholder,
        summaryFormat: category.summaryFormat,
        actionsMenuTitle: category.actionsMenuTitle,
      },
    ];
  }
}
