import type { RecordDraft } from '@eltjs/elt';
import type { AccessOptionKey } from '@eltjs/sdk-apple-accounts';

import type { AccountsScan } from '../accounts-scan.ts';
import {
  AppleAccountsStream,
  accountsFields,
} from '../apple-accounts-stream.ts';

const { id, integer, nullableInteger, integers } = accountsFields;

const properties = {
  id: {
    ...integer,
    description:
      'The option key row (ZACCESSOPTIONSKEY.Z_PK); the primary key.',
  },
  name: {
    ...id,
    description:
      'Option key name, such as ACFacebookAppIdKey. The store does not keep it unique.',
  },
  enumValue: {
    ...nullableInteger,
    description:
      "The Accounts framework's number for the key as stored; NULL when it holds none.",
  },
  accountTypeIds: {
    ...integers,
    description:
      'Account types the key applies to, each an accountTypes.id within this source; empty when none.',
  },
} as const;

export class AccessOptionKeysStream extends AppleAccountsStream<
  typeof properties,
  AccessOptionKey
> {
  readonly name = 'accessOptionKeys';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per option key an app passes when it asks for access to a kind of account, such as a Facebook app identifier. Primary key id.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: AccountsScan): Iterable<AccessOptionKey> {
    return scan.snapshot.accessOptionKeys();
  }

  protected records(key: AccessOptionKey): RecordDraft<typeof properties>[] {
    return [
      {
        id: key.id,
        name: key.name,
        enumValue: key.enumValue,
        accountTypeIds: [...key.accountTypeIds],
      },
    ];
  }
}
