import { readFile } from 'node:fs/promises';

import { DocumentFormat } from './document-format.ts';
import type { FileHead } from './file-head.ts';

export class VCardFormat extends DocumentFormat {
  protected override readonly extensions = ['vcf'];

  protected override hasSignature(head: FileHead): boolean {
    return head.ascii.startsWith('BEGIN:VCARD');
  }

  override text(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }
}
