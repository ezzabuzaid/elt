import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { parseOffice } from 'officeparser';

import { OfficeDocumentParser } from './office-document-parser.ts';

// officeparser writes Office and OpenDocument files from any parsed document,
// so Markdown and CSV give real DOCX, PPTX, XLSX, ODT, ODP and ODS files.
async function office(
  path: string,
  source: string,
  sourceType: 'md' | 'csv',
  format: 'docx' | 'pptx' | 'xlsx' | 'odt' | 'odp' | 'ods',
) {
  const document = await parseOffice(Buffer.from(source), {
    fileType: sourceType,
  });
  const { value } = await document.to(format);
  await writeFile(path, value);
}

// officeparser writes PDF only through pdf-lib or puppeteer, which this
// repository does not install, so the test writes the PDF syntax itself.
async function pdf(path: string, text: string, password = false) {
  const content = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  // A standard security handler whose user password is not empty: a reader
  // must ask for a password before it can read the page.
  if (password)
    objects.push(
      `<< /Filter /Standard /V 1 /R 2 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> /P -4 >>`,
    );
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  const encryption = password
    ? ` /Encrypt 6 0 R /ID [<${'01'.repeat(16)}> <${'01'.repeat(16)}>]`
    : '';
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryption} >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(path, body, 'latin1');
}

test('a Word document parses to its paragraphs', async () => {
  await using directory = await new TemporaryFiles().directory('office-');
  const path = join(directory.path, 'Proposal.docx');
  await office(
    path,
    '# Proposal\n\nShip the parser by Friday.\n',
    'md',
    'docx',
  );

  const text = await new OfficeDocumentParser().parse(path);

  assert.equal(text, 'Proposal\nShip the parser by Friday.');
});

test('a PowerPoint deck parses to the text of its slides', async () => {
  await using directory = await new TemporaryFiles().directory('office-');
  const path = join(directory.path, 'Kickoff.pptx');
  await office(
    path,
    '# Kickoff\n\nGoals for the quarter.\n\n# Budget\n\nReview the costs.\n',
    'md',
    'pptx',
  );

  const text = await new OfficeDocumentParser().parse(path);

  assert.equal(
    text,
    'Kickoff\nGoals for the quarter.\nBudget\nReview the costs.',
  );
});

test('an Excel workbook parses to the text of its cells', async () => {
  await using directory = await new TemporaryFiles().directory('office-');
  const path = join(directory.path, 'Revenue.xlsx');
  await office(path, 'Region,Revenue\nNorth,1200\n', 'csv', 'xlsx');

  const text = await new OfficeDocumentParser().parse(path);

  assert.equal(text, 'Region\tRevenue\nNorth\t1200');
});

test('an OpenDocument text parses to its paragraphs', async () => {
  await using directory = await new TemporaryFiles().directory('office-');
  const path = join(directory.path, 'Notes.odt');
  await office(path, '# Notes\n\nCall the client on Monday.\n', 'md', 'odt');

  const text = await new OfficeDocumentParser().parse(path);

  assert.match(text ?? '', /Notes[\s\S]*Call the client on Monday\./);
});

test('an OpenDocument presentation parses to the text of its slides', async () => {
  await using directory = await new TemporaryFiles().directory('office-');
  const path = join(directory.path, 'Deck.odp');
  await office(path, '# Deck\n\nGrowth plan for 2027.\n', 'md', 'odp');

  const text = await new OfficeDocumentParser().parse(path);

  assert.match(text ?? '', /Growth plan for 2027\./);
});

test('an OpenDocument spreadsheet parses to the text of its cells', async () => {
  await using directory = await new TemporaryFiles().directory('office-');
  const path = join(directory.path, 'Budget.ods');
  await office(path, 'Team,Budget\nDelivery,3400\n', 'csv', 'ods');

  const text = await new OfficeDocumentParser().parse(path);

  assert.match(text ?? '', /Delivery\s+3400/);
});

test('a Word document without text parses to null', async () => {
  await using directory = await new TemporaryFiles().directory('office-');
  const path = join(directory.path, 'Empty.docx');
  await office(path, '', 'md', 'docx');

  const text = await new OfficeDocumentParser().parse(path);

  assert.equal(text, null);
});

test('a PDF parses to the text of its pages', async () => {
  await using directory = await new TemporaryFiles().directory('office-');
  const path = join(directory.path, 'Invoice.pdf');
  await pdf(path, 'Invoice total 42');

  const text = await new OfficeDocumentParser().parse(path);

  assert.equal(text, 'Invoice total 42');
});

test('a PDF without text parses to null', async () => {
  await using directory = await new TemporaryFiles().directory('office-');
  const path = join(directory.path, 'Blank.pdf');
  await pdf(path, '');

  const text = await new OfficeDocumentParser().parse(path);

  assert.equal(text, null);
});

test('a password-protected PDF fails with the reason, so the text dataset records an error', async () => {
  await using directory = await new TemporaryFiles().directory('office-');
  const path = join(directory.path, 'Salaries.pdf');
  await pdf(path, 'Salary table', true);

  await assert.rejects(
    new OfficeDocumentParser().parse(path),
    /refused Salaries\.pdf: PASSWORD_REQUIRED/,
  );
});

test('a photo named as a Word document fails with the reason', async () => {
  await using directory = await new TemporaryFiles().directory('office-');
  const path = join(directory.path, 'x.docx');
  await writeFile(
    path,
    Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff,
      0xd9,
    ]),
  );

  await assert.rejects(
    new OfficeDocumentParser().parse(path),
    /refused x\.docx: [A-Z_]+/,
  );
});

test('a Word document named as a PDF fails with the reason', async () => {
  await using directory = await new TemporaryFiles().directory('office-');
  const path = join(directory.path, 'Proposal.pdf');
  await office(path, '# Proposal\n', 'md', 'docx');

  await assert.rejects(
    new OfficeDocumentParser().parse(path),
    /refused Proposal\.pdf: [A-Z_]+/,
  );
});

test('a photo named as an RTF document fails rather than load its bytes as text', async () => {
  await using directory = await new TemporaryFiles().directory('office-');
  const path = join(directory.path, 'x.rtf');
  await writeFile(
    path,
    Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff,
      0xd9,
    ]),
  );

  await assert.rejects(
    new OfficeDocumentParser().parse(path),
    /x\.rtf is not an RTF document/,
  );
});

test('an RTF document parses to its text', async () => {
  await using directory = await new TemporaryFiles().directory('office-');
  const path = join(directory.path, 'Memo.rtf');
  await writeFile(path, '{\\rtf1\\ansi Meet at noon.\\par}');

  const text = await new OfficeDocumentParser().parse(path);

  assert.equal(text, 'Meet at noon.');
});

test('a file of a format the parser does not read parses to null without being read', async () => {
  await using directory = await new TemporaryFiles().directory('office-');

  const text = await new OfficeDocumentParser().parse(
    join(directory.path, 'team photo.jpg'),
  );

  assert.equal(text, null);
});

test('a missing file throws', async () => {
  await using directory = await new TemporaryFiles().directory('office-');

  await assert.rejects(
    new OfficeDocumentParser().parse(join(directory.path, 'Gone.docx')),
    { code: 'ENOENT' },
  );
});

test('the parser accepts the names of the formats it reads, in any case, and no other name', () => {
  const parser = new OfficeDocumentParser();

  assert.deepEqual(
    [
      'Proposal.DOCX',
      'Kickoff.pptx',
      'Revenue.xlsx',
      'Notes.odt',
      'Deck.odp',
      'Budget.ods',
      'Invoice.pdf',
      'Memo.rtf',
    ].filter((name) => !parser.accepts(name)),
    [],
  );
  assert.deepEqual(
    [
      'team photo.jpg',
      'clip.mp4',
      'data.csv',
      'README.md',
      'page.html',
      'LICENSE',
    ].filter((name) => parser.accepts(name)),
    [],
  );
});

test('the identity of a stored file is the identity of the parser, with no read of its bytes', async () => {
  const parser = new OfficeDocumentParser();

  const identity = await parser.identityFor({
    name: 'Proposal.docx',
    head: () => assert.fail('identityFor read the bytes of the file'),
  });

  assert.equal(identity, parser.identity);
});

test('an already-aborted parse rejects with an AbortError', async () => {
  await using directory = await new TemporaryFiles().directory('office-');
  const path = join(directory.path, 'Proposal.docx');
  await office(
    path,
    '# Proposal\n\nShip the parser by Friday.\n',
    'md',
    'docx',
  );

  await assert.rejects(
    new OfficeDocumentParser().parse(path, AbortSignal.abort()),
    { name: 'AbortError' },
  );
});
