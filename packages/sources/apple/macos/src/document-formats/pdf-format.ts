import { resolve } from 'node:path';

import osa from '../osa.ts';
import { DocumentFormat } from './document-format.ts';
import type { FileHead } from './file-head.ts';

export class PdfFormat extends DocumentFormat {
  protected override readonly extensions = ['pdf'];

  protected override hasSignature(head: FileHead): boolean {
    return head.ascii.startsWith('%PDF-');
  }

  override async text(path: string): Promise<string | null> {
    const content: unknown = JSON.parse(
      await osa.execute(`
        ObjC.import('PDFKit');
        const document = $.PDFDocument.alloc.initWithURL(
          $.NSURL.fileURLWithPath(${JSON.stringify(resolve(path))})
        );
        if (document.isNil()) throw new Error('Cannot read PDF');
        const content = document.isLocked ? null : ObjC.unwrap(document.string);
        JSON.stringify(typeof content === 'string' && content.length > 0 ? content : null);
      `),
    );
    if (content !== null && typeof content !== 'string')
      throw new TypeError('PDFKit returned unexpected content');
    return content;
  }
}
