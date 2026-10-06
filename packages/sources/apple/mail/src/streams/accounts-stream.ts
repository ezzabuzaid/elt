import {
  AppleMailStream,
  type MailEntry,
  mailSchema,
} from '../apple-mail-stream.ts';
import { described, metadata } from '../mail-fields.ts';
import type { MailScan } from '../mail-scan.ts';
import type { MailSelection } from '../mail-selection.ts';

export class AccountsStream extends AppleMailStream {
  readonly name = 'accounts';
  readonly primaryKey = ['id'];
  readonly jsonSchema = mailSchema(
    'One record per Mail account that owns mailboxes: each host of mailboxes.url, read from the system Accounts store (~/Library/Accounts/Accounts4.sqlite) without Mail scripting or Automation access. A host the store does not know, such as an On My Mac account, keeps only what its URL says. Primary key id. properties is JSON data; no password or authentication property is read.',
    described(metadata, {
      id: 'The Accounts store identifier of the account, which Mail uses as the host of its mailbox URLs and as its folder name; the host of mailboxes.url matches it within this source.',
      properties:
        "JSON object: id; name (the account description, else its parent account's, such as iCloud or Google); type (the Accounts store account type, such as com.apple.account.IMAP, or the URL scheme for a host the store does not know); parentType (the type of the account it belongs to, such as com.apple.account.AppleAccount for iCloud, else null); enabled (active with Mail turned on for it or its parent, null when unknown); emailAddresses (its own and its parent's identity address and aliases, and for iCloud the Apple ID aliases and the iCloud Mail address); fullName; userName; serverName, port and usesSsl of its incoming server (the Exchange EWS host); directory (its folder in the Mail store); sendingServerId (the account it sends through: an smtpServers.id, or its own id for an Exchange account, which sends through EWS; else null). A value the store does not hold is null. Kept as data without interpretation.",
    }),
  );

  protected *entries(scan: MailScan): Generator<MailEntry, void, undefined> {
    for (const data of scan.accountRecords().accounts)
      yield { data, file: null };
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.account(record.id);
  }
}
