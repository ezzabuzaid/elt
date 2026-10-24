import { extname } from 'node:path';

import { DocumentParser } from '@workspace/elt';

import type { DocumentFormat } from './document-formats/document-format.ts';
import { FileHead } from './document-formats/file-head.ts';
import { PdfFormat } from './document-formats/pdf-format.ts';
import { TextFormat } from './document-formats/text-format.ts';
import { VCardFormat } from './document-formats/vcard-format.ts';

export class MacOSDocumentParser extends DocumentParser {
  readonly #formats: readonly DocumentFormat[];

  constructor(additionalFormats: readonly DocumentFormat[] = []) {
    const formats = [
      new PdfFormat(),
      new TextFormat(),
      new VCardFormat(),
      ...additionalFormats,
    ];
    super(
      JSON.stringify([
        'macos-document',
        ...formats.map(({ identity }) => identity),
      ]),
    );
    this.#formats = formats;
    Object.freeze(this);
  }

  // Hosts supply ImageFormat with their Vision worker and AudioFormat with
  // their speech model. Unrecognized files, locked PDFs and files without
  // recognizable text return null. Unreadable files throw.
  override async parse(
    path: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    signal?.throwIfAborted();
    const format = await this.#format(path);
    signal?.throwIfAborted();
    return format === undefined ? null : format.text(path, signal);
  }

  override async identityFor(path: string): Promise<string | null> {
    return (await this.#format(path))?.identity ?? null;
  }

  async #format(path: string): Promise<DocumentFormat | undefined> {
    const extension = extname(path).slice(1).toLowerCase();
    const head = await FileHead.read(path);
    for (const format of this.#formats)
      if (await format.supports(extension, head)) return format;
    return undefined;
  }
}
