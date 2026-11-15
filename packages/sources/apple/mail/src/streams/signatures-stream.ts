import {
  AppleMailStream,
  type MailEntry,
  mailSchema,
} from '../apple-mail-stream.ts';
import { described, text } from '../mail-fields.ts';
import type { MailScan } from '../mail-scan.ts';

export class SignaturesStream extends AppleMailStream {
  readonly name = 'signatures';
  // The file system keeps paths unique, not file names (ADR 0022).
  readonly primaryKey = ['relativePath'];
  readonly jsonSchema = mailSchema(
    'One record per .mailsignature file in the current Mail store. Primary key relativePath. No link to accounts is stated; scoped imports omit this stream.',
    described(
      { relativePath: text, name: text, content: text },
      {
        relativePath:
          'Path of the .mailsignature file relative to the current Mail version directory; the primary key.',
        name: 'File name of the .mailsignature file without its extension. Files in different folders can share it.',
        content:
          'The whole file read as UTF-8 text, including its MIME headers; not parsed.',
      },
    ),
  );

  protected async *entries(
    scan: MailScan,
  ): AsyncGenerator<MailEntry, void, undefined> {
    const { files } = scan.snapshot;
    for (const file of files.signatures) {
      const signature = await files.signature(file);
      yield {
        data: {
          relativePath: files.relative(file),
          name: signature.name,
          content: signature.content,
        },
        file: null,
      };
    }
  }

  // Signatures of no proven account: a scoped import omits them rather than
  // copying unrelated settings.
  protected accepts(): boolean {
    return false;
  }
}
