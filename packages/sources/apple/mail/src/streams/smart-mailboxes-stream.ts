import {
  AppleMailStream,
  type MailEntry,
  mailSchema,
} from '../apple-mail-stream.ts';
import {
  described,
  metadata,
  nullableText,
  plistJSON,
  plistProperties,
} from '../mail-fields.ts';
import type { MailScan } from '../mail-scan.ts';

export class SmartMailboxesStream extends AppleMailStream {
  readonly name = 'smartMailboxes';
  readonly primaryKey = ['id'];
  readonly jsonSchema = mailSchema(
    'One record per smart mailbox dictionary in MailData/SyncedSmartMailboxes.plist, including those nested under MailboxChildren. Primary key id. parentId refers to the containing smart mailbox. Conditions are smartMailboxConditions rows whose ownerId is id. Scoped imports omit this stream.',
    described(
      { ...metadata, parentId: nullableText },
      {
        id: 'MailboxID value of the smart mailbox.',
        properties: `The whole smart mailbox dictionary, including its MailboxCriteria and nested MailboxChildren. ${plistProperties}`,
        parentId:
          'Refers to smartMailboxes.id of the smart mailbox whose MailboxChildren contains this one; NULL at the top level.',
      },
    ),
  );

  protected async *entries(
    scan: MailScan,
  ): AsyncGenerator<MailEntry, void, undefined> {
    for await (const mailbox of scan.snapshot.files.smartMailboxes())
      yield {
        data: {
          id: mailbox.id,
          parentId: mailbox.parentId,
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
