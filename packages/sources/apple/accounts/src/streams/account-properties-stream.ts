import { plistJSON } from '@workspace/codec-plist';
import type { RecordDraft } from '@workspace/elt';
import type { Account } from '@workspace/sdk-apple-accounts';

import type { AccountsScan } from '../accounts-scan.ts';
import {
  AppleAccountsStream,
  accountsFields,
} from '../apple-accounts-stream.ts';

const { id, text } = accountsFields;

const properties = {
  accountId: {
    ...id,
    description:
      'The account the property belongs to; refers to accounts.id within this source.',
  },
  key: {
    ...id,
    description:
      'Property name as stored, such as Hostname, IdentityEmailAddress or appleIDAliases.',
  },
  value: {
    ...text,
    description:
      'The property value as JSON, decoded from its keyed archive: bytes as base64, dates as ISO 8601, large integers as strings. Kept as data without interpretation.',
  },
} as const;

export class AccountPropertiesStream extends AppleAccountsStream<
  typeof properties,
  Account
> {
  readonly name = 'accountProperties';
  readonly primaryKey = ['accountId', 'key'];
  readonly jsonSchema = {
    type: 'object',
    description:
      "One record per property of an account in the system Accounts store: server settings, aliases, iCloud service flags and other values apps keep on the account. Primary key (accountId, key). Authentication material is not copied: the iTunes Store's encrypted last sign-in response (lastAuthenticationServerResponse), the Apple ID's next liveness nonce (nextLivenessNonce) and Game Center's opaque player record (GKPlayerInternal) are left out, and so is AuthID inside account-info. Passwords are not in this store.",
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: AccountsScan): readonly Account[] {
    return scan.accounts;
  }

  protected records(account: Account): RecordDraft<typeof properties>[] {
    return Object.entries(account.propertiesWithoutAuthentication).map(
      ([key, value]) => ({
        accountId: account.identifier,
        key,
        value: plistJSON(value),
      }),
    );
  }
}
