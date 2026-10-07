import { plistJSON } from '@workspace/codec-plist';

import {
  AppleMailStream,
  type MailEntry,
  mailSchema,
} from '../apple-mail-stream.ts';
import { described, plistFields, plistProperties } from '../mail-fields.ts';
import type { MailScan } from '../mail-scan.ts';

export class ConfigurationStream extends AppleMailStream {
  readonly name = 'configuration';
  readonly primaryKey = ['relativePath'];
  readonly jsonSchema = mailSchema(
    'One record per property list file under a MailData or Signatures directory of the current Mail store, except files under RemoteContentURLCache or BiomeStream. Primary key relativePath. It includes the rule and smart mailbox files that rules and smartMailboxes also read. Scoped imports omit this stream.',
    described(plistFields, {
      relativePath:
        'Path of the property list file relative to the current Mail version directory.',
      properties: plistProperties,
    }),
  );

  protected async *entries(
    scan: MailScan,
  ): AsyncGenerator<MailEntry, void, undefined> {
    const { files } = scan.snapshot;
    for (const file of files.configuration())
      yield {
        data: {
          relativePath: files.relative(file),
          properties: plistJSON(await files.plist(file)),
        },
        file: null,
      };
  }

  // Settings of no proven account: a scoped import omits them rather than
  // copying unrelated settings.
  protected accepts(): boolean {
    return false;
  }
}
