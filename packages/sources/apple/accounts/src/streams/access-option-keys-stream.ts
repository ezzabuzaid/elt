import type { RecordDraft } from '@workspace/elt';
import type { AccessOptionKey } from '@workspace/sdk-apple-accounts';

import type { AccountsScan } from '../accounts-scan.ts';
import {
  AppleAccountsStream,
  accountsFields,
} from '../apple-accounts-stream.ts';

const { id, nullableInteger, strings } = accountsFields;

const properties = {
  name: {
    ...id,
    description:
      'Option key name, such as ACFacebookAppIdKey; the primary key.',
  },
  enumValue: {
    ...nullableInteger,
    description:
      "The Accounts framework's number for the key as stored; NULL when it holds none.",
  },
  accountTypes: {
    ...strings,
    description:
      'Account types the key applies to, each an accountTypes.id within this source; empty when none.',
  },
} as const;

export class AccessOptionKeysStream extends AppleAccountsStream<
  typeof properties,
  AccessOptionKey
> {
  readonly name = 'accessOptionKeys';
  readonly primaryKey = ['name'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per option key an app passes when it asks for access to a kind of account, such as a Facebook app identifier. Primary key name.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: AccountsScan): readonly AccessOptionKey[] {
    return scan.accessOptionKeys;
  }

  protected records(key: AccessOptionKey): RecordDraft<typeof properties>[] {
    return [
      {
        name: key.name,
        enumValue: key.enumValue,
        accountTypes: [...key.accountTypes],
      },
    ];
  }
}
