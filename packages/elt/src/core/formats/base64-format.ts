import { FieldFormat } from './field-format.ts';

// contentEncoding: 'base64': bytes as padded RFC 4648 base64, the one
// spelling its bytes have. The alphabet does not sort as bytes do, so it
// cannot be a cursor.
export class Base64Format extends FieldFormat {
  readonly name = 'base64';
  override readonly orderable = false;

  accepts(value: string): boolean {
    return (
      /^[A-Za-z0-9+/]*={0,2}$/.test(value) &&
      value.length % 4 === 0 &&
      Buffer.from(value, 'base64').toString('base64') === value
    );
  }
}
