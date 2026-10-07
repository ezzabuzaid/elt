import { plistJSON } from '@workspace/codec-plist';

import {
  AppleMailStream,
  type MailEntry,
  mailSchema,
} from '../apple-mail-stream.ts';
import { described, plistFields, plistProperties } from '../mail-fields.ts';
import type { MailScan } from '../mail-scan.ts';

export class MailboxPropertiesStream extends AppleMailStream {
  readonly name = 'mailboxProperties';
  readonly primaryKey = ['relativePath'];
  readonly jsonSchema = mailSchema(
    'One record per Info.plist file inside a .mbox directory of the current Mail store. Primary key relativePath. This source does not map these files to mailboxes.id, so no join is stated; scoped imports omit this stream.',
    described(plistFields, {
      relativePath:
        'Path of the Info.plist file relative to the current Mail version directory.',
      properties: plistProperties,
    }),
  );

  protected async *entries(
    scan: MailScan,
  ): AsyncGenerator<MailEntry, void, undefined> {
    const { files } = scan.snapshot;
    for (const file of files.mailboxProperties())
      yield {
        data: {
          relativePath: files.relative(file),
          properties: plistJSON(await files.plist(file)),
        },
        file: null,
      };
  }

  // No proven mailbox: a scoped import omits these records rather than
  // guessing joins.
  protected accepts(): boolean {
    return false;
  }
}
