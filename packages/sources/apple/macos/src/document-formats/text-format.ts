import { execFile } from 'node:child_process';
import { extname, resolve } from 'node:path';
import { promisify } from 'node:util';

import { DocumentFormat } from './document-format.ts';
import type { FileHead } from './file-head.ts';

const execute = promisify(execFile);

// Native textutil formats, as advertised by /usr/bin/textutil -help.
const textutilFormats = ['txt', 'rtf', 'html', 'doc', 'docx', 'odt', 'wordml'];

export class TextFormat extends DocumentFormat {
  protected override readonly extensions = [...textutilFormats, 'md'];

  // RTF is the one text format that names itself in its leading bytes.
  protected override hasSignature(head: FileHead): boolean {
    return head.ascii.startsWith('{\\rtf');
  }

  override async text(path: string): Promise<string> {
    const { stdout, stderr } = await execute('/usr/bin/textutil', [
      '-convert',
      'txt',
      '-format',
      textutilFormat(path),
      '-stdout',
      '-noload',
      '-nostore',
      '--',
      resolve(path),
    ]);
    // textutil reports read/format errors on stderr with exit code zero.
    if (stderr) throw new Error(stderr.trim());
    return stdout;
  }
}

// textutil reads Markdown as plain text; a file known only by its leading
// bytes is RTF.
function textutilFormat(path: string): string {
  const extension = extname(path).slice(1).toLowerCase();
  if (extension === 'md') return 'txt';
  return textutilFormats.includes(extension) ? extension : 'rtf';
}
