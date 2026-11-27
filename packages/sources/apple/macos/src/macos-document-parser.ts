import { extname } from 'node:path';

import { DeprecatedRevisionError } from '@zukhruf/pool';

import {
  type DocumentFile,
  DocumentParser,
  EscalatedFailure,
} from '@eltjs/elt';

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

  // Hosts supply ImageFormat with their OCR pool and AudioFormat with their
  // speech model. Unrecognized files, locked PDFs and files without
  // recognizable text return null. Unreadable files throw. A pool whose store
  // holds a newer revision of its kind is deprecated, and the host must start
  // again on the newer code (pool ADR 0022), so its error escalates: no row
  // of the file fails (elt ADR 0037).
  override async parse(
    path: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    signal?.throwIfAborted();
    const format = await this.#format(path, await FileHead.read(path));
    signal?.throwIfAborted();
    try {
      return format === undefined ? null : await format.text(path, signal);
    } catch (error) {
      if (error instanceof DeprecatedRevisionError)
        throw new EscalatedFailure(error);
      throw error;
    }
  }

  override async identityFor(file: DocumentFile): Promise<string | null> {
    const head = new FileHead(await file.head(FileHead.length));
    return (await this.#format(file.name, head))?.identity ?? null;
  }

  async #format(
    name: string,
    head: FileHead,
  ): Promise<DocumentFormat | undefined> {
    const extension = extname(name).slice(1).toLowerCase();
    for (const format of this.#formats)
      if (await format.supports(extension, head)) return format;
    return undefined;
  }
}
