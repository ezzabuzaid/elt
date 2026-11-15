import { plistJSON } from '@eltjs/codec-plist';
import type { RecordDraft } from '@eltjs/elt';
import type { AccountProperty } from '@eltjs/sdk-apple-accounts';

import type { AccountsScan } from '../accounts-scan.ts';
import {
  AppleAccountsStream,
  accountsFields,
} from '../apple-accounts-stream.ts';

const { id, integer, text } = accountsFields;

const properties = {
  id: {
    ...integer,
    description: 'The property row (ZACCOUNTPROPERTY.Z_PK); the primary key.',
  },
  accountId: {
    ...integer,
    description:
      'The account the property belongs to; refers to accounts.id within this source.',
  },
  key: {
    ...id,
    description:
      'Property name as stored, such as Hostname, IdentityEmailAddress or appleIDAliases. The store does not keep it unique for an account.',
  },
  value: {
    ...text,
    description:
      'The property value as JSON, decoded from its keyed archive: bytes as base64, dates as ISO 8601, large integers as strings. Kept as data without interpretation.',
  },
} as const;

export class AccountPropertiesStream extends AppleAccountsStream<
  typeof properties,
  AccountProperty
> {
  readonly name = 'accountProperties';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      "One record per property of an account in the system Accounts store: server settings, aliases, iCloud service flags and other values apps keep on the account. Primary key id. Authentication material is not copied: the iTunes Store's encrypted last sign-in response (lastAuthenticationServerResponse), the Apple ID's next liveness nonce (nextLivenessNonce) and Game Center's opaque player record (GKPlayerInternal) are left out, and so is AuthID inside account-info. Passwords are not in this store.",
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: AccountsScan): Iterable<AccountProperty> {
    return scan.snapshot.accountProperties();
  }

  protected records(
    property: AccountProperty,
  ): RecordDraft<typeof properties>[] {
    return [
      {
        id: property.id,
        accountId: property.accountId,
        key: property.key,
        value: plistJSON(property.value),
      },
    ];
  }
}
