import type { RecordDraft } from '@eltjs/elt';
import type { AccountType } from '@eltjs/sdk-apple-accounts';

import type { AccountsScan } from '../accounts-scan.ts';
import {
  AppleAccountsStream,
  accountsFields,
} from '../apple-accounts-stream.ts';

const {
  id,
  integer,
  nullableText,
  nullableBoolean,
  nullableInteger,
  integers,
} = accountsFields;
const stored = (what: string) =>
  `${what} as the Accounts framework stores it; NULL when it holds none.`;

const properties = {
  id: {
    ...integer,
    description:
      'The account type row (ZACCOUNTTYPE.Z_PK); the primary key. accounts.typeId, authorizations.accountTypeId and accessOptionKeys.accountTypeIds refer to it within this source.',
  },
  identifier: {
    ...id,
    description:
      'Account type identifier, such as com.apple.account.IMAP. The store does not keep it unique.',
  },
  description: {
    ...nullableText,
    description: stored('The type description, such as IMAP'),
  },
  credentialType: {
    ...nullableText,
    description: stored('The credential type its accounts use'),
  },
  credentialProtectionPolicy: {
    ...nullableText,
    description: stored('The credential protection policy'),
  },
  owningBundleId: {
    ...nullableText,
    description: stored('The bundle identifier of the app that owns the type'),
  },
  obsolete: {
    ...nullableBoolean,
    description: stored('Whether the type is obsolete'),
  },
  supportsAuthentication: {
    ...nullableBoolean,
    description: stored('Whether its accounts sign in'),
  },
  supportsMultipleAccounts: {
    ...nullableBoolean,
    description: stored('Whether one Mac can hold several accounts of it'),
  },
  visibility: {
    ...nullableInteger,
    description: stored('The visibility value'),
  },
  supportedDataclassIds: {
    ...integers,
    description:
      'Data classes its accounts can offer, each a dataclasses.id within this source; empty when none.',
  },
  syncableDataclassIds: {
    ...integers,
    description:
      'Data classes its accounts can sync, each a dataclasses.id within this source; empty when none.',
  },
} as const;

export class AccountTypesStream extends AppleAccountsStream<
  typeof properties,
  AccountType
> {
  readonly name = 'accountTypes';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per kind of account the Accounts framework knows on this Mac, whether or not an account of it exists. Primary key id.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: AccountsScan): Iterable<AccountType> {
    return scan.snapshot.accountTypes();
  }

  protected records(type: AccountType): RecordDraft<typeof properties>[] {
    return [
      {
        id: type.id,
        identifier: type.identifier,
        description: type.description,
        credentialType: type.credentialType,
        credentialProtectionPolicy: type.credentialProtectionPolicy,
        owningBundleId: type.owningBundleId,
        obsolete: type.obsolete,
        supportsAuthentication: type.supportsAuthentication,
        supportsMultipleAccounts: type.supportsMultipleAccounts,
        visibility: type.visibility,
        supportedDataclassIds: [...type.supportedDataclassIds],
        syncableDataclassIds: [...type.syncableDataclassIds],
      },
    ];
  }
}
