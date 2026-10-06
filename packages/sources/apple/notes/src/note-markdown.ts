import {
  type NoteAttachmentReference,
  type NoteDocument,
  type Paragraph,
  type Run,
  attachmentCharacter,
} from '@workspace/sdk-apple-notes';

// How the notes stream writes a note body: plain text, and Markdown with
// checklists, emphasis, links and tables. Fonts, colors and underline have no
// Markdown form.

// The visible text, with each attachment character replaced as the caller
// renders it: an inline tag by its text, a file by nothing.
export function plainText(
  document: NoteDocument,
  attachment: (reference: NoteAttachmentReference) => string,
): string {
  return document.paragraphs
    .map((paragraph) =>
      paragraph.runs
        .map(({ text, attachment: reference }) =>
          reference === null
            ? text
            : text.replaceAll(attachmentCharacter, () => attachment(reference)),
        )
        .join(''),
    )
    .join('\n');
}

// Attachments render through the caller: a table becomes its cells, an
// inline tag its text, a file a link to the attachment row.
export function markdown(
  document: NoteDocument,
  attachment: (reference: NoteAttachmentReference) => string,
): string {
  const lines: string[] = [];
  const numbers: number[] = [];
  let monospaced = false;
  for (const paragraph of document.paragraphs) {
    const code = paragraph.style === 'monospaced';
    if (code !== monospaced) {
      lines.push('```');
      monospaced = code;
    }
    if (code) {
      lines.push(plain(paragraph));
      continue;
    }
    const numbered = paragraph.style === 'numbered';
    numbers.length = numbered ? paragraph.indent + 1 : 0;
    if (numbered)
      numbers[paragraph.indent] =
        paragraph.startNumber ?? (numbers[paragraph.indent] ?? 0) + 1;
    // Notes draws headings bold; the heading marker already says so.
    const heading =
      paragraph.style === 'title' ||
      paragraph.style === 'heading' ||
      paragraph.style === 'subheading';
    const content = merge(
      heading
        ? paragraph.runs.map((run) => ({ ...run, bold: false }))
        : paragraph.runs,
    )
      .map((run) => inline(run, attachment))
      .join('');
    if (content === '') {
      lines.push('');
      continue;
    }
    const quote = '> '.repeat(paragraph.blockQuote);
    const prefix = linePrefix(paragraph, numbers[paragraph.indent]);
    lines.push(
      `${quote}${prefix}${prefix === '' ? escapeLineStart(content) : content}`,
    );
  }
  if (monospaced) lines.push('```');
  return lines.join('\n');
}

// The Markdown marker a paragraph style opens its line with. A numbered
// paragraph passes the number its list has reached at its indent.
function linePrefix(paragraph: Paragraph, number: number | undefined): string {
  const indent = '  '.repeat(paragraph.indent);
  switch (paragraph.style) {
    case 'title':
      return '# ';
    case 'heading':
      return '## ';
    case 'subheading':
      return '### ';
    case 'bullet':
    case 'dash':
      return `${indent}- `;
    case 'numbered':
      return `${indent}${number}. `;
    case 'checklist':
      return `${indent}- [${paragraph.todo?.done ? 'x' : ' '}] `;
    default:
      return '';
  }
}

const plain = (paragraph: Paragraph) =>
  paragraph.runs
    .map((run) => run.text)
    .join('')
    .replaceAll(attachmentCharacter, '');

// Runs that differ only in what Markdown cannot show (fonts, underline) join,
// so emphasis wraps a phrase once instead of each fragment.
const merge = (runs: readonly Run[]): Run[] =>
  runs.reduce<Run[]>((merged, run) => {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      previous.attachment === null &&
      run.attachment === null &&
      previous.bold === run.bold &&
      previous.italic === run.italic &&
      previous.strikethrough === run.strikethrough &&
      previous.link === run.link
    )
      merged[merged.length - 1] = {
        ...previous,
        text: previous.text + run.text,
      };
    else merged.push(run);
    return merged;
  }, []);

const escapeInline = (text: string) => text.replace(/[\\`*_[\]~<]/g, '\\$&');

// Text that would read as Markdown structure at the start of a line.
const escapeLineStart = (line: string) =>
  line.replace(/^(\s*)([#>+-]|\d+[.)])(?=\s|$)/, '$1\\$2');

const inline = (
  run: Run,
  attachment: (reference: NoteAttachmentReference) => string,
): string => {
  const { attachment: reference } = run;
  if (reference !== null)
    return run.text
      .split('')
      .map((character) =>
        character === attachmentCharacter
          ? attachment(reference)
          : escapeInline(character),
      )
      .join('');
  const text = run.text.trim();
  if (text === '') return run.text;
  let body = escapeInline(text);
  if (run.strikethrough) body = `~~${body}~~`;
  if (run.bold && run.italic) body = `***${body}***`;
  else if (run.bold) body = `**${body}**`;
  else if (run.italic) body = `*${body}*`;
  if (run.link !== null) body = `[${body}](<${run.link}>)`;
  // Emphasis markers must hug the text, so surrounding spaces stay outside.
  const leading = run.text.slice(
    0,
    run.text.length - run.text.trimStart().length,
  );
  const trailing = run.text.slice(run.text.trimEnd().length);
  return `${leading}${body}${trailing}`;
};

export function markdownTable(grid: readonly (readonly string[])[]): string {
  if (grid.length === 0) return '';
  const cell = (text: string) =>
    escapeInline(text).replaceAll('|', '\\|').replaceAll('\n', '<br>');
  const row = (cells: readonly string[]) =>
    `| ${cells.map(cell).join(' | ')} |`;
  const [header = [], ...body] = grid;
  return [
    row(header),
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map(row),
  ].join('\n');
}
