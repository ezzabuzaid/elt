import type { RecordDraft } from '@workspace/elt';
import type { AccountDocument } from '@workspace/sdk-apple-eventkit';

import type { CalendarScan } from '../calendar-scan.ts';
import { CalendarStream, calendarFields } from '../calendar-stream.ts';

const { id, text, ordinal, boolean } = calendarFields;

const properties = {
  id: {
    ...id,
    description:
      'EventKit EKSource.sourceIdentifier; accountId of the calendars stream within this source refers to it.',
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

export class AccountsStream extends CalendarStream<
  typeof properties,
  AccountDocument
> {
  readonly name = 'accounts';
  readonly jsonSchema = {
    type: 'object',
    description:
      "One source record per EventKit account (EKSource) in this Mac's event store, including accounts without event calendars. No date filter: the event window does not restrict it. An import scope keeps the selected accounts; a calendar scope also drops accounts owning no selected calendar. Relationships name source streams, not destination tables.",
    properties,
    required: Object.keys(properties),
  } as const;
  override readonly dated = false;

  protected rows(scan: CalendarScan): readonly AccountDocument[] {
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
