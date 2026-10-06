import {
  AppleMailStream,
  type MailEntry,
  mailSchema,
} from '../apple-mail-stream.ts';
import { described, metadata } from '../mail-fields.ts';
import type { MailScan } from '../mail-scan.ts';

export class SmtpServersStream extends AppleMailStream {
  readonly name = 'smtpServers';
  readonly primaryKey = ['id'];
  readonly jsonSchema = mailSchema(
    'One record per SMTP server account in the system Accounts store (~/Library/Accounts/Accounts4.sqlite), read without Mail scripting or Automation access. Primary key id. accounts.properties.sendingServerId refers to id for an account that sends through SMTP; scoped imports still omit this stream, because a server can serve accounts outside the scope.',
    described(metadata, {
      id: 'The Accounts store identifier of the SMTP account.',
      properties:
        "JSON object: id; name (its parent account's description, such as iCloud or Google); userName; serverName; port; usesSsl; enabled. For iCloud the server settings come from the parent account's Mail settings. A value the store does not hold is null; no password is read. Kept as data without interpretation.",
    }),
  );

  protected *entries(scan: MailScan): Generator<MailEntry, void, undefined> {
    for (const data of scan.accountRecords().smtpServers)
      yield { data, file: null };
  }

  // A server can serve accounts outside the scope, so a scoped import omits
  // it.
  protected accepts(): boolean {
    return false;
  }
}
