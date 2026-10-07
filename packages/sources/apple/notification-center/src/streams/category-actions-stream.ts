import type { RecordDraft } from '@workspace/elt';
import type { CategoryAction } from '@workspace/sdk-apple-notification-center';

import {
  AppleNotificationCenterStream,
  notificationCenterFields,
} from '../apple-notification-center-stream.ts';
import type { NotificationCenterScan } from '../notification-center-scan.ts';

const { id, ordinal, nullableInteger, nullableText } = notificationCenterFields;

const properties = {
  bundleId: {
    ...id,
    description: 'The app that registered it; refers to apps.bundleId.',
  },
  categoryPosition: {
    ...ordinal,
    description:
      'Its category; refers to categories.position for the same app.',
  },
  position: {
    ...ordinal,
    description: 'Its place among the category’s buttons, from 0.',
  },
  id: { ...id, description: 'The action identifier (id).' },
  title: {
    ...nullableText,
    description:
      'The button’s title (ti), or its localization key when the app registered it localized.',
  },
  options: {
    ...nullableInteger,
    description: 'Its UNNotificationActionOptions bits (op).',
  },
  typeCode: {
    ...nullableInteger,
    description:
      'usernoted’s code for the kind of action (st): 1 on a text-input action, NULL on a plain one; Apple does not document the codes.',
  },
  textInputButtonTitle: {
    ...nullableText,
    description:
      'A text-input action’s send button title (tia), or its localization key; NULL on a plain action.',
  },
  textInputPlaceholder: {
    ...nullableText,
    description:
      'A text-input action’s placeholder (tip), or its localization key; NULL on a plain action.',
  },
} as const;

type Action = CategoryAction & {
  readonly bundleId: string;
  readonly categoryPosition: number;
};

export class CategoryActionsStream extends AppleNotificationCenterStream<
  typeof properties,
  Action
> {
  readonly name = 'categoryActions';
  readonly primaryKey = ['bundleId', 'categoryPosition', 'position'];
  readonly emitsDeletes = true;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per button a notification category puts on its notifications, such as Reply or Mark as Read. Primary key bundleId, categoryPosition, position.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: NotificationCenterScan): readonly Action[] {
    return scan.categories.flatMap((category) =>
      category.actions.map((action) => ({
        ...action,
        bundleId: category.bundleId,
        categoryPosition: category.position,
      })),
    );
  }

  protected records(action: Action): RecordDraft<typeof properties>[] {
    return [
      {
        bundleId: action.bundleId,
        categoryPosition: action.categoryPosition,
        position: action.position,
        id: action.id,
        title: action.title,
        options: action.options,
        typeCode: action.typeCode,
        textInputButtonTitle: action.textInputButtonTitle,
        textInputPlaceholder: action.textInputPlaceholder,
      },
    ];
  }
}
