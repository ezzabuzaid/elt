import type { RecordDraft } from '@workspace/elt';
import type { Account } from '@workspace/sdk-apple-accounts';

import type { AccountsScan } from '../accounts-scan.ts';
import {
  AppleAccountsStream,
  accountsFields,
} from '../apple-accounts-stream.ts';

const { id, boolean } = accountsFields;

const properties = {
  accountId: {
    ...id,
    description: 'The account; refers to accounts.id within this source.',
  },
  dataclass: {
    ...id,
    description:
      'Data class name, such as com.apple.Dataclass.Mail; refers to dataclasses.name within this source.',
  },
  enabled: {
    ...boolean,
    description:
      'Whether the data class is turned on for this account. A child account, such as IMAP under iCloud, can rely on its parent having it on.',
  },
  provisioned: {
    ...boolean,
    description:
      'Whether the account is set up to offer the data class, on or off.',
  },
} as const;

export class AccountDataclassesStream extends AppleAccountsStream<
  typeof properties,
  Account
> {
  readonly name = 'accountDataclasses';
  readonly primaryKey = ['accountId', 'dataclass'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per data class an account offers or has turned on: what it syncs, such as mail, calendars or contacts. Primary key (accountId, dataclass).',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: AccountsScan): readonly Account[] {
    return scan.accounts;
  }

  protected records(account: Account): RecordDraft<typeof properties>[] {
    return [
      ...new Set([
        ...account.provisionedDataclasses,
        ...account.enabledDataclasses,
      ]),
    ].map((dataclass) => ({
      accountId: account.identifier,
      dataclass,
      enabled: account.enabledDataclasses.includes(dataclass),
      provisioned: account.provisionedDataclasses.includes(dataclass),
    }));
  }
}
