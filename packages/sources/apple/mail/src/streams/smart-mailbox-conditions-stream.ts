import { plistJSON } from '@eltjs/codec-plist';

import {
  AppleMailStream,
  type MailEntry,
  mailSchema,
} from '../apple-mail-stream.ts';
import { described, plistProperties, text } from '../mail-fields.ts';
import type { MailScan } from '../mail-scan.ts';

const integer = { type: 'integer' } as const;

export class SmartMailboxConditionsStream extends AppleMailStream {
  readonly name = 'smartMailboxConditions';
  readonly primaryKey = ['mailboxPath', 'position'];
  readonly jsonSchema = mailSchema(
    "One record per entry of a smart mailbox's MailboxCriteria list, in stored order. Primary key (mailboxPath, position). mailboxPath refers to smartMailboxes.path within this source; these conditions do not join to rules. Scoped imports omit this stream.",
    described(
      { mailboxPath: text, position: integer, properties: text },
      {
        mailboxPath:
          'Path of the owning smart mailbox; refers to smartMailboxes.path within this source.',
        position:
          "Zero-based position of the condition in the smart mailbox's MailboxCriteria list.",
        properties: `The condition dictionary. ${plistProperties}`,
      },
    ),
  );

  protected async *entries(
    scan: MailScan,
  ): AsyncGenerator<MailEntry, void, undefined> {
    for await (const mailbox of scan.snapshot.files.smartMailboxes())
      for (const [position, criterion] of mailbox.conditions().entries())
        yield {
          data: {
            mailboxPath: mailbox.path,
            position,
            properties: plistJSON(criterion),
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
