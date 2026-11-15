import type { RecordDraft } from '@eltjs/elt';
import type { Account } from '@eltjs/sdk-apple-accounts';

import type { AccountsScan } from '../accounts-scan.ts';
import {
  AppleAccountsStream,
  accountsFields,
} from '../apple-accounts-stream.ts';

const { integer, nullableText, boolean } = accountsFields;

const properties = {
  accountId: {
    ...integer,
    description: 'The account; refers to accounts.id within this source.',
  },
  dataclassId: {
    ...integer,
    description: 'The data class; refers to dataclasses.id within this source.',
  },
  dataclass: {
    ...nullableText,
    description:
      'Data class name, such as com.apple.Dataclass.Mail (dataclasses.name); NULL when the store holds no row for the data class.',
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
  readonly primaryKey = ['accountId', 'dataclassId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per data class an account offers or has turned on: what it syncs, such as mail, calendars or contacts. Primary key (accountId, dataclassId), the key of both join tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: AccountsScan): Iterable<Account> {
    return scan.accounts;
  }

  protected records(account: Account): RecordDraft<typeof properties>[] {
    return account.dataclasses.map((dataclass) => ({
      accountId: account.id,
      dataclassId: dataclass.dataclassId,
      dataclass: dataclass.name,
      enabled: dataclass.enabled,
      provisioned: dataclass.provisioned,
    }));
  }
}
