import type { RecordDraft } from '@eltjs/elt';
import type { CredentialItem } from '@eltjs/sdk-apple-accounts';

import type { AccountsScan } from '../accounts-scan.ts';
import {
  AppleAccountsStream,
  accountsFields,
} from '../apple-accounts-stream.ts';

const { id, integer, nullableBoolean, nullableTimestamp } = accountsFields;

const properties = {
  id: {
    ...integer,
    description:
      'The credential item row (ZCREDENTIALITEM.Z_PK); the primary key.',
  },
  accountIdentifier: {
    ...id,
    description:
      'Identifier of the account the credential belongs to, as stored, not a link to its row; matches accounts.identifier within this source while that account exists.',
  },
  serviceName: {
    ...id,
    description: 'The service the credential is for, as stored.',
  },
  expiresAt: {
    ...nullableTimestamp,
    description:
      'When the credential expires, from Core Data seconds since 2001-01-01 rounded to the millisecond; NULL when not recorded.',
  },
  persistent: {
    ...nullableBoolean,
    description:
      'Whether the credential is kept, as stored; NULL when it holds none.',
  },
} as const;

export class CredentialItemsStream extends AppleAccountsStream<
  typeof properties,
  CredentialItem
> {
  readonly name = 'credentialItems';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per stored credential the Accounts framework tracks: when it expires, not the credential, which lives in the keychain and is not read. Primary key id.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: AccountsScan): Iterable<CredentialItem> {
    return scan.snapshot.credentialItems();
  }

  protected records(item: CredentialItem): RecordDraft<typeof properties>[] {
    return [
      {
        id: item.id,
        accountIdentifier: item.accountIdentifier,
        serviceName: item.serviceName,
        expiresAt: item.expiresAt?.toISOString() ?? null,
        persistent: item.persistent,
      },
    ];
  }
}
