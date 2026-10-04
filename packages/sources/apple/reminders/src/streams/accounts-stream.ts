import type { RecordDraft } from '@workspace/elt';
import type { AccountDocument } from '@workspace/macos-eventkit';

import {
  AppleRemindersStream,
  remindersFields,
} from '../apple-reminders-stream.ts';
import type { RemindersScan } from '../reminders-scan.ts';

const { id, text, ordinal, boolean } = remindersFields;

const properties = {
  id: {
    ...id,
    description:
      'EventKit EKSource.sourceIdentifier; accountId of the lists stream within this source refers to it.',
  },
  name: { ...text, description: 'EventKit EKSource.title.' },
  type: {
    ...ordinal,
    description:
      'EventKit EKSource.sourceType raw value (EKSourceType): 0 local, 1 Exchange, 2 CalDAV, 3 MobileMe, 4 subscribed, 5 birthdays. Unknown codes are kept as numbers.',
  },
  isDelegate: {
    ...boolean,
    description:
      'EventKit EKSource.isDelegate: whether the account is delegated by another user.',
  },
} as const;

export class AccountsStream extends AppleRemindersStream<
  typeof properties,
  AccountDocument
> {
  readonly name = 'accounts';
  readonly jsonSchema = {
    type: 'object',
    description:
      "One source record per EventKit account (EKSource) in this Mac's store, including accounts without reminder lists. An import scope keeps the selected accounts; a list scope also drops accounts owning no selected list. Relationships name source streams, not destination tables.",
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: RemindersScan): readonly AccountDocument[] {
    return scan.accounts;
  }

  protected record(account: AccountDocument): RecordDraft<typeof properties> {
    return {
      id: account.id,
      name: account.name,
      type: account.sourceType,
      isDelegate: account.isDelegate,
    };
  }
}
