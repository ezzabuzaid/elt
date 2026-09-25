import { execFile } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DocumentParser } from 'elt';
import osa from '../platform/macos/osa.ts';

const execute = promisify(execFile);

type Kind = 'pdf' | 'text' | 'image' | 'audio' | 'video' | 'vcard' | 'unknown';

// Native textutil formats, as advertised by /usr/bin/textutil -help.
const textutilFormats = ['txt', 'rtf', 'html', 'doc', 'docx', 'odt', 'wordml'];

const extensions: Record<string, Kind> = {
  pdf: 'pdf',
  md: 'text',
  ...Object.fromEntries(textutilFormats.map((format) => [format, 'text'])),
  vcf: 'vcard',
  ...Object.fromEntries(
    [
      'jpg',
      'jpeg',
      'png',
      'gif',
      'heic',
      'heif',
      'tif',
      'tiff',
      'bmp',
      'ico',
      'webp',
    ].map((extension) => [extension, 'image']),
  ),
  ...Object.fromEntries(
    ['caf', 'm4a', 'amr', 'mp3', 'wav', 'aac', 'aif', 'aiff'].map(
      (extension) => [extension, 'audio'],
    ),
  ),
  ...Object.fromEntries(
    ['mov', 'mp4', 'm4v', '3gp'].map((extension) => [extension, 'video']),
  ),
};

// Some files carry no usable extension, such as Messages' GroupPhotoImage or
// pluginPayloadAttachment; their leading bytes name the format.
async function sniff(path: string): Promise<{ kind: Kind; format?: string }> {
  await using file = await open(path);
  const head = new Uint8Array(16);
  const { bytesRead } = await file.read(head, 0, 16, 0);
  const ascii = new TextDecoder('latin1').decode(head.subarray(0, bytesRead));
  const starts = (...bytes: number[]) =>
    bytes.every((byte, index) => head[index] === byte);
  if (starts(0xff, 0xd8, 0xff)) return { kind: 'image' };
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { kind: 'image' };
  if (ascii.startsWith('GIF8')) return { kind: 'image' };
  if (ascii.startsWith('II*\0') || ascii.startsWith('MM\0*'))
    return { kind: 'image' };
  if (starts(0x00, 0x00, 0x01, 0x00)) return { kind: 'image' };
  if (ascii.startsWith('BM')) return { kind: 'image' };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP')
    return { kind: 'image' };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE')
    return { kind: 'audio' };
  if (ascii.startsWith('%PDF')) return { kind: 'pdf' };
  if (ascii.startsWith('caff') || ascii.startsWith('#!AMR'))
    return { kind: 'audio' };
  if (ascii.startsWith('BEGIN:VCARD')) return { kind: 'vcard' };
  if (ascii.startsWith('{\\rtf')) return { kind: 'text', format: 'rtf' };
  if (ascii.slice(4, 8) === 'ftyp') {
    const brand = ascii.slice(8, 12);
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1', 'avif'].includes(brand))
      return { kind: 'image' };
    if (brand === 'M4A ') return { kind: 'audio' };
    return { kind: 'video' };
  }
  return { kind: 'unknown' };
}

export class MacOSDocumentParser extends DocumentParser {
  constructor() {
    super('macos-document-v2');
    Object.freeze(this);
  }

  // Documents convert natively, images through Vision text recognition,
  // contact cards as their text. Audio and video (macOS lets only an app
  // bundle use Speech), unknown formats, locked PDFs and files with no
  // recognizable text load as null. Unreadable files throw.
  override async parse(path: string): Promise<string | null> {
    const extension = extname(path).slice(1).toLowerCase();
    const known = extensions[extension];
    const { kind, format } =
      known === undefined
        ? await sniff(path)
        : { kind: known, format: extension === 'md' ? 'txt' : extension };
    switch (kind) {
      case 'pdf':
        return pdfText(path);
      case 'text':
        return convertedText(path, format ?? 'txt');
      case 'image':
        return recognizedText(path);
      case 'vcard':
        return readFile(path, 'utf8');
      case 'audio':
      case 'video':
      case 'unknown':
        return null;
    }
  }
}

async function pdfText(path: string): Promise<string | null> {
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

async function convertedText(path: string, format: string): Promise<string> {
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

// Vision's accurate text recognition, one line per observation.
async function recognizedText(path: string): Promise<string | null> {
  const content: unknown = JSON.parse(
    await osa.execute(`
      ObjC.import('Vision');
      const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(
        $.NSURL.fileURLWithPath(${JSON.stringify(resolve(path))}), $()
      );
      const request = $.VNRecognizeTextRequest.alloc.init;
      request.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
      request.automaticallyDetectsLanguage = true;
      const error = Ref();
      if (!handler.performRequestsError($([request]), error))
        throw new Error('Cannot read image: ' + ObjC.unwrap(error[0].localizedDescription));
      const lines = [];
      const results = request.results;
      for (let index = 0; index < results.count; index++)
        lines.push(ObjC.unwrap(results.objectAtIndex(index).topCandidates(1).objectAtIndex(0).string));
      JSON.stringify(lines.length > 0 ? lines.join('\\n') : null);
    `),
  );
  if (content !== null && typeof content !== 'string')
    throw new TypeError('Vision returned unexpected content');
  return content;
}
