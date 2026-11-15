import { plistJSON } from '@eltjs/codec-plist';
import type { RecordDraft } from '@eltjs/elt';
import type { Authorization } from '@eltjs/sdk-apple-accounts';

import type { AccountsScan } from '../accounts-scan.ts';
import {
  AppleAccountsStream,
  accountsFields,
} from '../apple-accounts-stream.ts';

const { id, integer, nullableText } = accountsFields;

const properties = {
  id: {
    ...integer,
    description:
      'The authorization row (ZAUTHORIZATION.Z_PK); the primary key.',
  },
  accountTypeId: {
    ...integer,
    description:
      'The kind of account access was granted to; refers to accountTypes.id within this source.',
  },
  accountType: {
    ...id,
    description:
      'Identifier of that account type, such as com.apple.account.Facebook (accountTypes.identifier).',
  },
  bundleId: {
    ...id,
    description: 'Bundle identifier of the app granted access.',
  },
  grantedPermissions: {
    ...nullableText,
    description:
      'The permissions granted, as the Accounts framework stores them; NULL when it holds none.',
  },
  options: {
    ...nullableText,
    description:
      'The access options as JSON, decoded from their keyed archive; NULL when none are stored. Kept as data without interpretation.',
  },
} as const;

export class AuthorizationsStream extends AppleAccountsStream<
  typeof properties,
  Authorization
> {
  readonly name = 'authorizations';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per app granted access to a kind of account through the Accounts framework. Primary key id.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: AccountsScan): Iterable<Authorization> {
    return scan.snapshot.authorizations();
  }

  protected records(
    authorization: Authorization,
  ): RecordDraft<typeof properties>[] {
    return [
      {
        id: authorization.id,
        accountTypeId: authorization.accountTypeId,
        accountType: authorization.accountType,
        bundleId: authorization.bundleId,
        grantedPermissions: authorization.grantedPermissions,
        options:
          authorization.options === null
            ? null
            : plistJSON(authorization.options),
      },
    ];
  }
}
