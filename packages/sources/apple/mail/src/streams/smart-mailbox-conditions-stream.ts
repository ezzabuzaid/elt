import { plistJSON } from '@workspace/codec-plist';

import {
  AppleMailStream,
  type MailEntry,
  mailSchema,
} from '../apple-mail-stream.ts';
import { conditionFields, described, plistProperties } from '../mail-fields.ts';
import type { MailScan } from '../mail-scan.ts';

export class SmartMailboxConditionsStream extends AppleMailStream {
  readonly name = 'smartMailboxConditions';
  readonly primaryKey = ['scope', 'ownerId', 'position'];
  readonly jsonSchema = mailSchema(
    "One record per entry of a smart mailbox's MailboxCriteria list, in stored order. Primary key (scope, ownerId, position). ownerId refers to smartMailboxes.id within this source; these conditions do not join to rules. Scoped imports omit this stream.",
    described(conditionFields, {
      scope:
        'Always Synced: only MailData/SyncedSmartMailboxes.plist is read. smartMailboxes has no scope field, so join on ownerId alone.',
      ownerId:
        'MailboxID of the owning smart mailbox; refers to smartMailboxes.id within this source.',
      position:
        "Zero-based position of the condition in the smart mailbox's MailboxCriteria list.",
      properties: `The condition dictionary. ${plistProperties}`,
    }),
  );

  protected async *entries(
    scan: MailScan,
  ): AsyncGenerator<MailEntry, void, undefined> {
    for await (const mailbox of scan.snapshot.files.smartMailboxes())
      for (const [position, criterion] of mailbox.conditions().entries())
        yield {
          data: {
            scope: 'Synced',
            ownerId: mailbox.id,
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
