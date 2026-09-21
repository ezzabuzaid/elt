import { execFile } from 'node:child_process';
import { extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DocumentParser } from 'elt';
import osa from '../platform/macos/osa.ts';

const execute = promisify(execFile);

export class MacOSDocumentParser extends DocumentParser {
  constructor() {
    super('macos-document-v1');
    Object.freeze(this);
  }

  override async parse(path: string): Promise<string> {
    const extension = extname(path).slice(1).toLowerCase();
    if (extension === 'pdf') {
      const content: unknown = JSON.parse(
        await osa.execute(`
          ObjC.import('PDFKit');
          const document = $.PDFDocument.alloc.initWithURL(
            $.NSURL.fileURLWithPath(${JSON.stringify(resolve(path))})
          );
          if (document.isNil()) throw new Error('Cannot read PDF');
          if (document.isLocked) throw new Error('PDF is locked');
          const content = ObjC.unwrap(document.string);
          if (typeof content !== 'string' || content.length === 0)
            throw new Error('PDF has no extractable text; use an OCR parser');
          JSON.stringify(content);
        `),
      );
      if (typeof content !== 'string')
        throw new TypeError('PDFKit returned unexpected content');
      return content;
    }

    // Native textutil formats, as advertised by /usr/bin/textutil -help.
    const format = extension === 'md' ? 'txt' : extension;
    if (
      !['txt', 'rtf', 'html', 'doc', 'docx', 'odt', 'wordml'].includes(format)
    )
      throw new TypeError(`Unsupported document format: ${extension}`);
    const { stdout, stderr } = await execute('/usr/bin/textutil', [
      '-convert',
      'txt',
      '-format',
      format,
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
