import {
  AppleMailStream,
  type MailEntry,
  mailSchema,
} from '../apple-mail-stream.ts';
import { accountFields, described } from '../mail-fields.ts';
import type { MailScan } from '../mail-scan.ts';
import type { MailSelection } from '../mail-selection.ts';

export class AccountsStream extends AppleMailStream {
  readonly name = 'accounts';
  // The store's row id, which it keeps unique; not its identifier, which it
  // does not (ADR 0022).
  readonly primaryKey = ['id'];
  readonly jsonSchema = mailSchema(
    'One record per account in the system Accounts store (~/Library/Accounts/Accounts4.sqlite) whose identifier is the host of a mailbox URL, read without Mail scripting or Automation access. An On My Mac host (local://) has no account in the store, so no record. Primary key id. properties is JSON data; no password or authentication property is read.',
    described(accountFields, {
      id: 'The account row in the Accounts store (ZACCOUNT.Z_PK); the primary key. Accounts accounts.id holds the same value.',
      identifier:
        'The Accounts store identifier of the account (ACAccount.identifier), which Mail uses as the host of its mailbox URLs and as its folder name; join the host of mailboxes.url to it. The store does not keep it unique.',
      properties:
        "JSON object: name (the account description, else its parent account's, such as iCloud or Google); type (the Accounts store account type, such as com.apple.account.IMAP); parentType (the type of the account it belongs to, such as com.apple.account.AppleAccount for iCloud, else null); enabled (active with Mail turned on for it or its parent); emailAddresses (its own and its parent's identity address and aliases, and for iCloud the Apple ID aliases and the iCloud Mail address); fullName; userName; serverName, port and usesSsl of its incoming server (the Exchange EWS host); directory (its folder in the Mail store); sendingServerIdentifier (the identifier of the account it sends through: an smtpServers.identifier, or its own identifier for an Exchange account, which sends through EWS; else null). A value the store does not hold is null. Kept as data without interpretation.",
    }),
  );

  protected *entries(scan: MailScan): Generator<MailEntry, void, undefined> {
    for (const data of scan.accountRecords().accounts)
      yield { data, file: null };
  }

  // An import scope names an account by its mailbox host.
  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.account(record.identifier);
  }
}
