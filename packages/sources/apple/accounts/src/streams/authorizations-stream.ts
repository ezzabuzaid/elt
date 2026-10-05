import type { RecordDraft } from '@workspace/elt';
import type { Authorization } from '@workspace/sdk-apple-accounts';
import { plistJSON } from '@workspace/sdk-apple-plist';

import type { AccountsScan } from '../accounts-scan.ts';
import {
  AppleAccountsStream,
  accountsFields,
} from '../apple-accounts-stream.ts';

const { id, nullableText } = accountsFields;

const properties = {
  accountType: {
    ...id,
    description:
      'The kind of account access was granted to; refers to accountTypes.id within this source.',
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
  readonly primaryKey = ['accountType', 'bundleId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per app granted access to a kind of account through the Accounts framework. Primary key (accountType, bundleId).',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: AccountsScan): readonly Authorization[] {
    return scan.authorizations;
  }

  protected records(
    authorization: Authorization,
  ): RecordDraft<typeof properties>[] {
    return [
      {
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
