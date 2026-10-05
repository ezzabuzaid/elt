import type { RecordDraft } from '@workspace/elt';
import type { AccountType } from '@workspace/macos-accounts';

import type { AccountsScan } from '../accounts-scan.ts';
import {
  AppleAccountsStream,
  accountsFields,
} from '../apple-accounts-stream.ts';

const { id, nullableText, nullableBoolean, nullableInteger, strings } =
  accountsFields;
const stored = (what: string) =>
  `${what} as the Accounts framework stores it; NULL when it holds none.`;

const properties = {
  id: {
    ...id,
    description:
      'Account type identifier, such as com.apple.account.IMAP; the primary key. accounts.type and accessOptionKeys.accountTypes refer to it within this source.',
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
  supportedDataclasses: {
    ...strings,
    description:
      'Data classes its accounts can offer, each a dataclasses.name within this source; empty when none.',
  },
  syncableDataclasses: {
    ...strings,
    description:
      'Data classes its accounts can sync, each a dataclasses.name within this source; empty when none.',
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

  protected rows(scan: AccountsScan): readonly AccountType[] {
    return scan.accountTypes;
  }

  protected records(type: AccountType): RecordDraft<typeof properties>[] {
    return [
      {
        id: type.identifier,
        description: type.description,
        credentialType: type.credentialType,
        credentialProtectionPolicy: type.credentialProtectionPolicy,
        owningBundleId: type.owningBundleId,
        obsolete: type.obsolete,
        supportsAuthentication: type.supportsAuthentication,
        supportsMultipleAccounts: type.supportsMultipleAccounts,
        visibility: type.visibility,
        supportedDataclasses: [...type.supportedDataclasses],
        syncableDataclasses: [...type.syncableDataclasses],
      },
    ];
  }
}
