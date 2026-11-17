import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { type OfficeIssue, parseOffice } from 'officeparser';

import { DocumentParser } from '@eltjs/elt';

const formats = [
  'docx',
  'pptx',
  'xlsx',
  'odt',
  'odp',
  'ods',
  'pdf',
  'rtf',
] as const;

const rtfSignature = Buffer.from('{\\rtf', 'latin1');

export class OfficeDocumentParser extends DocumentParser {
  constructor() {
    super('office-document:officeparser@8');
    Object.freeze(this);
  }

  override accepts(fileName: string): boolean {
    return format(fileName) !== undefined;
  }

  // A file of a format this parser does not read, and a document without
  // text, return null. A file that cannot be read, a document that is not the
  // format its name says or that a password locks, and a document whose text
  // officeparser cut at one of its limits throw: the DocumentText dataset
  // then records the reason as an error, apart from a document with no text.
  override async parse(
    path: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const fileType = format(path);
    if (fileType === undefined) return null;
    const bytes = await readFile(path, { signal });
    // officeparser reads any bytes as RTF text, so a photo named .rtf would
    // load as its raw bytes.
    if (fileType === 'rtf' && !bytes.subarray(0, 5).equals(rtfSignature))
      throw new Error(`${basename(path)} is not an RTF document`);
    const issues: OfficeIssue[] = [];
    let text: string;
    try {
      const document = await parseOffice(bytes, {
        fileType,
        abortSignal: signal ?? null,
        onWarning: (issue) => issues.push(issue),
      });
      ({ value: text } = await document.to('text', { includeImages: false }));
    } catch (failure) {
      // When officeparser wraps an error of pdf.js, only its report carries
      // the code. An abort reports none, so it stays an AbortError.
      const code = issues.findLast(({ type }) => type === 'error')?.code;
      if (code === undefined) throw failure;
      throw new Error(`officeparser refused ${basename(path)}: ${code}`, {
        cause: failure,
      });
    }
    const cut = issues.find(({ code }) => code.endsWith('_LIMIT_EXCEEDED'));
    if (cut !== undefined)
      throw new Error(
        `officeparser read only part of ${basename(path)}: ${cut.code}`,
      );
    return text.trim() === '' ? null : text;
  }
}

function format(fileName: string) {
  const extension = extname(fileName).slice(1).toLowerCase();
  return formats.find((candidate) => candidate === extension);
}
