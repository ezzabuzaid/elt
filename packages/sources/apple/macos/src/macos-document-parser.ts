import { extname } from 'node:path';

import { DocumentParser } from '@workspace/elt';

import type { DocumentFormat } from './document-formats/document-format.ts';
import { FileHead } from './document-formats/file-head.ts';
import { ImageFormat } from './document-formats/image-format.ts';
import { PdfFormat } from './document-formats/pdf-format.ts';
import { TextFormat } from './document-formats/text-format.ts';
import { VCardFormat } from './document-formats/vcard-format.ts';

export class MacOSDocumentParser extends DocumentParser {
  readonly #formats: readonly DocumentFormat[] = [
    new PdfFormat(),
    new TextFormat(),
    new ImageFormat(),
    new VCardFormat(),
  ];

  constructor() {
    super('macos-document-v4');
    Object.freeze(this);
  }

  // Documents convert natively, images through Vision text recognition,
  // contact cards as their text. Files no format recognizes, locked PDFs and
  // files with no recognizable text load as null. Unreadable files throw.
  override async parse(path: string): Promise<string | null> {
    const extension = extname(path).slice(1).toLowerCase();
    const head = await FileHead.read(path);
    const format = this.#formats.find((each) => each.supports(extension, head));
    return format === undefined ? null : format.text(path);
  }
}
