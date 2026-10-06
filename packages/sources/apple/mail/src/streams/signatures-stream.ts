import {
  AppleMailStream,
  type MailEntry,
  mailSchema,
} from '../apple-mail-stream.ts';
import { described, text } from '../mail-fields.ts';
import type { MailScan } from '../mail-scan.ts';

export class SignaturesStream extends AppleMailStream {
  readonly name = 'signatures';
  readonly primaryKey = ['id'];
  readonly jsonSchema = mailSchema(
    'One record per .mailsignature file in the current Mail store. Primary key id. No link to accounts is stated; scoped imports omit this stream.',
    described(
      { id: text, content: text },
      {
        id: 'File name of the .mailsignature file without its extension.',
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
        data: { id: signature.name, content: signature.content },
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
