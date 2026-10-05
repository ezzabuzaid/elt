import type { RecordDraft } from '@workspace/elt';
import type { Account } from '@workspace/sdk-apple-accounts';
import { plistJSON } from '@workspace/sdk-apple-plist';

import type { AccountsScan } from '../accounts-scan.ts';
import {
  AppleAccountsStream,
  accountsFields,
} from '../apple-accounts-stream.ts';

const {
  id,
  nullableId,
  nullableText,
  text,
  boolean,
  nullableBoolean,
  nullableTimestamp,
  strings,
} = accountsFields;
const stored = (what: string) =>
  `${what} as the Accounts framework stores it; NULL when it holds none.`;

const properties = {
  id: {
    ...id,
    description:
      'Account identifier (ACAccount.identifier); the primary key. parentId, accountProperties.accountId and accountDataclasses.accountId refer to it within this source. Mail names its account folders and the hosts of its mailbox URLs after it.',
  },
  type: {
    ...id,
    description:
      'Account type identifier, such as com.apple.account.IMAP; refers to accountTypes.id within this source.',
  },
  parentId: {
    ...nullableId,
    description:
      'The account this one belongs to, such as an IMAP or SMTP account under its iCloud or Google account; refers to id within this source. NULL for a top-level account.',
  },
  description: {
    ...nullableText,
    description: stored('The account description'),
  },
  name: {
    ...nullableText,
    description:
      "The account's description, else its parent account's, such as iCloud or Google: the name the account appears under. NULL when neither has one.",
  },
  username: {
    ...nullableText,
    description: `${stored('The user name on this account')} A child account often leaves it to its parent.`,
  },
  fullName: {
    ...nullableText,
    description:
      "The account's full name property, else its parent's; NULL when neither has one.",
  },
  emailAddresses: {
    ...strings,
    description:
      "Its own and its parent account's identity address and aliases, the Apple ID aliases and the iCloud Mail address, in that order and each once; empty when it has none.",
  },
  active: { ...boolean, description: 'Whether the account is turned on.' },
  authenticated: {
    ...nullableBoolean,
    description: stored('Whether the account is signed in'),
  },
  supportsAuthentication: {
    ...nullableBoolean,
    description: stored('Whether the account signs in at all'),
  },
  visible: {
    ...nullableBoolean,
    description: stored('Whether the account shows in System Settings'),
  },
  warmingUp: {
    ...nullableBoolean,
    description: stored('Whether the account is still being set up'),
  },
  createdAt: {
    ...nullableTimestamp,
    description:
      'When the account was added to this Mac (ZACCOUNT.ZDATE, Core Data seconds since 2001-01-01, rounded to the millisecond); NULL when not recorded.',
  },
  lastCredentialRenewalRejectedAt: {
    ...nullableTimestamp,
    description:
      'When renewing its credential was last refused; NULL when never recorded.',
  },
  authenticationType: {
    ...nullableText,
    description: stored('The authentication type'),
  },
  credentialType: {
    ...nullableText,
    description: stored('The credential type'),
  },
  modificationId: {
    ...nullableText,
    description: stored('The modification identifier'),
  },
  owningBundleId: {
    ...nullableText,
    description: stored(
      'The bundle identifier of the app that owns the account',
    ),
  },
  dataclassProperties: {
    ...text,
    description:
      "JSON object of per data class settings, keyed by data class name, such as iCloud's Mail servers and service URLs; {} when none. Bytes are base64, dates ISO 8601, large integers strings. Kept as data without interpretation.",
  },
} as const;

export class AccountsStream extends AppleAccountsStream<
  typeof properties,
  Account
> {
  readonly name = 'accounts';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      "One record per account in this Mac's system Accounts store (~/Library/Accounts/Accounts4.sqlite): the accounts Mail, Calendar, Contacts, Notes and other apps sync through, often as children of the account the user signed in with. Primary key id. Read without the Accounts framework or any app's scripting.",
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: AccountsScan): readonly Account[] {
    return scan.accounts;
  }

  protected records(account: Account): RecordDraft<typeof properties>[] {
    return [
      {
        id: account.identifier,
        type: account.type,
        parentId: account.parent?.identifier ?? null,
        description: account.description,
        name: account.name,
        username: account.username,
        fullName: account.fullName,
        emailAddresses: account.emailAddresses,
        active: account.active,
        authenticated: account.authenticated,
        supportsAuthentication: account.supportsAuthentication,
        visible: account.visible,
        warmingUp: account.warmingUp,
        createdAt: account.createdAt?.toISOString() ?? null,
        lastCredentialRenewalRejectedAt:
          account.lastCredentialRenewalRejectedAt?.toISOString() ?? null,
        authenticationType: account.authenticationType,
        credentialType: account.credentialType,
        modificationId: account.modificationId,
        owningBundleId: account.owningBundleId,
        dataclassProperties: plistJSON(account.dataclassProperties),
      },
    ];
  }
}
