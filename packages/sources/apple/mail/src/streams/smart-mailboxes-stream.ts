import { plistJSON } from '@eltjs/codec-plist';

import {
  AppleMailStream,
  type MailEntry,
  mailSchema,
} from '../apple-mail-stream.ts';
import {
  described,
  nullableText,
  plistProperties,
  text,
} from '../mail-fields.ts';
import type { MailScan } from '../mail-scan.ts';

export class SmartMailboxesStream extends AppleMailStream {
  readonly name = 'smartMailboxes';
  // The file's tree enforces no identity, so a smart mailbox is its path in
  // the tree (ADR 0022); MailboxID is a column.
  readonly primaryKey = ['path'];
  readonly jsonSchema = mailSchema(
    'One record per smart mailbox dictionary in MailData/SyncedSmartMailboxes.plist, including those nested under MailboxChildren, each before its children. Primary key path. parentPath refers to the containing smart mailbox. Conditions are smartMailboxConditions rows whose mailboxPath is path. Scoped imports omit this stream.',
    described(
      {
        path: text,
        parentPath: nullableText,
        mailboxId: text,
        properties: text,
      },
      {
        path: 'Zero-based position of the smart mailbox in each list from the top of the file, joined by slashes, such as 0/1 for the second child of the first smart mailbox; the primary key.',
        parentPath:
          'Refers to smartMailboxes.path of the smart mailbox whose MailboxChildren contains this one; NULL at the top level.',
        mailboxId:
          'MailboxID value of the smart mailbox. The file does not keep it unique, so two smart mailboxes can share it.',
        properties: `The whole smart mailbox dictionary, including its MailboxCriteria and nested MailboxChildren. ${plistProperties}`,
      },
    ),
  );

  protected async *entries(
    scan: MailScan,
  ): AsyncGenerator<MailEntry, void, undefined> {
    for await (const mailbox of scan.snapshot.files.smartMailboxes())
      yield {
        data: {
          path: mailbox.path,
          parentPath: mailbox.parentPath,
          mailboxId: mailbox.mailboxId,
          properties: plistJSON(mailbox.dictionary),
        },
        file: null,
      };
  }

  // Searches of no proven account: a scoped import omits them rather than
  // copying unrelated settings.
  protected accepts(): boolean {
    return false;
  }
}
