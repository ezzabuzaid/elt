import { gunzipSync, inflateSync } from 'node:zlib';

import { ProtobufMessage } from '@workspace/codec-protobuf';

// Notes stores each note body (ZICNOTEDATA.ZDATA) and each table
// (ZMERGEABLEDATA1) as a compressed versioned_document.Document whose newest
// version holds a protobuf: topotext.String for a note, CRDT.Document for a
// table. Field numbers follow Apple's schema as recovered by
// apple_cloud_notes_parser and icloud-md, checked against macOS 26 stores.

const decompress = (bytes: Uint8Array): Uint8Array =>
  bytes[0] === 0x1f && bytes[1] === 0x8b
    ? gunzipSync(bytes)
    : inflateSync(bytes);

const versionData = (bytes: Uint8Array): ProtobufMessage => {
  const data = new ProtobufMessage(decompress(bytes))
    .messages(2)
    .at(-1)
    ?.bytes(3);
  if (data === undefined)
    throw new TypeError('Notes document has no version data');
  return new ProtobufMessage(data);
};

const uuid = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

export type ParagraphStyle =
  | 'title'
  | 'heading'
  | 'subheading'
  | 'monospaced'
  | 'bullet'
  | 'dash'
  | 'numbered'
  | 'checklist'
  | 'body';

// topotext ParagraphStyle.style by number. An absent style is body text, and
// so is one this reader does not know.
const paragraphStyles = new Map<number | undefined, ParagraphStyle>([
  [0, 'title'],
  [1, 'heading'],
  [2, 'subheading'],
  [4, 'monospaced'],
  [100, 'bullet'],
  [101, 'dash'],
  [102, 'numbered'],
  [103, 'checklist'],
]);

export type NoteAttachmentReference = {
  readonly id: string;
  readonly type: string | null;
};

export type Run = {
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strikethrough: boolean;
  readonly link: string | null;
  readonly attachment: NoteAttachmentReference | null;
};

export type Paragraph = {
  readonly style: ParagraphStyle;
  readonly indent: number;
  readonly blockQuote: number;
  readonly startNumber: number | undefined;
  readonly todo: { readonly id: string; readonly done: boolean } | undefined;
  readonly runs: readonly Run[];
};

// The attachment character Notes puts where an attachment sits in the text.
export const attachmentCharacter = '\ufffc';

// A note body's paragraphs, each a style and runs of formatted text, with
// attachment characters marking where attachments sit.
export class NoteDocument {
  readonly paragraphs: readonly Paragraph[];

  private constructor(paragraphs: readonly Paragraph[]) {
    this.paragraphs = paragraphs;
  }

  static decode(bytes: Uint8Array): NoteDocument {
    const note = versionData(bytes);
    // String.string is the visible text; deleted text lives only in the
    // substring history. Run lengths count UTF-16 code units, as JS does.
    const text = note.string(2) ?? '';
    const paragraphs: Paragraph[] = [];
    let current: Run[] = [];
    let style: ProtobufMessage | undefined;
    let offset = 0;
    const close = () => {
      const todo = style?.message(5);
      paragraphs.push({
        style: paragraphStyles.get(style?.uint(1)) ?? 'body',
        indent: style?.uint(4) ?? 0,
        blockQuote: style?.uint(8) ?? 0,
        startNumber: style?.uint(7),
        todo:
          todo === undefined
            ? undefined
            : {
                id: uuid(todo.bytes(1) ?? new Uint8Array()),
                done: todo.uint(2) === 1,
              },
        runs: current,
      });
      current = [];
      style = undefined;
    };
    for (const run of note.messages(5)) {
      const length = run.uint(1) ?? 0;
      const segment = text.slice(offset, offset + length);
      offset += length;
      const hints = run.uint(5) ?? 0;
      const attachment = run.message(12);
      const base = {
        bold: (hints & 1) !== 0,
        italic: (hints & 2) !== 0,
        strikethrough: (run.uint(7) ?? 0) !== 0,
        link: run.string(9) ?? null,
        attachment:
          attachment === undefined
            ? null
            : {
                id: attachment.string(1) ?? '',
                type: attachment.string(2) ?? null,
              },
      };
      // A paragraph takes the style of the run holding its newline; a run may
      // span several paragraphs, so split it at each newline.
      const lines = segment.split('\n');
      lines.forEach((line, index) => {
        if (line !== '') current.push({ ...base, text: line });
        style = run.message(2);
        if (index < lines.length - 1) close();
      });
    }
    if (offset < text.length)
      current.push({
        text: text.slice(offset),
        bold: false,
        italic: false,
        strikethrough: false,
        link: null,
        attachment: null,
      });
    if (current.length > 0) close();
    return new NoteDocument(paragraphs);
  }
}

// A table's rows × columns of cell text, in visual order. The CRDT keeps an
// object pool: pool[0] maps crRows/crColumns (ordered sets of row and column
// identities) and cellColumns (column → row → cell text) by key name.
export function decodeTable(bytes: Uint8Array): string[][] {
  const document = versionData(bytes);
  const objects = document.messages(3);
  const keys = document.strings(4);
  const uuidItems = document.bytesList(6);
  const reference = (id: ProtobufMessage | undefined, label: string) => {
    const index = id?.uint(6);
    const object = index === undefined ? undefined : objects[index];
    if (object === undefined)
      throw new TypeError(`Notes table ${label} is not an object reference`);
    return object;
  };
  const entries = (object: ProtobufMessage, label: string) => {
    const custom = object.message(13);
    if (custom === undefined)
      throw new TypeError(`Notes table ${label} is not a keyed object`);
    return new Map(
      custom
        .messages(3)
        .map((entry) => [keys[entry.uint(1) ?? -1], entry.message(2)] as const),
    );
  };
  const table = entries(objects[0] ?? reference(undefined, 'root'), 'root');
  // A row or column identity is a keyed object holding an index into the
  // document's UUID table; positions are keyed by that index.
  const identity = (object: ProtobufMessage) => {
    const index = entries(object, 'identity').get('UUIDIndex')?.uint(2);
    if (index === undefined)
      throw new TypeError('Notes table identity has no UUID index');
    return index;
  };
  const positions = (key: string) => {
    const set = reference(table.get(key), key).message(16);
    const array = set?.message(1);
    if (array === undefined)
      throw new TypeError(`Notes table ${key} is not an ordered set`);
    const order = new Map<number, number>();
    (array.message(1)?.messages(2) ?? []).forEach((entry, position) => {
      const id = entry.bytes(2);
      const index = uuidItems.findIndex(
        (item) => id !== undefined && Buffer.from(item).equals(id),
      );
      if (index === -1)
        throw new TypeError(`Notes table ${key} names an unknown identity`);
      order.set(index, position);
    });
    // Each entry's ordering identity redirects to the content identity that
    // cells use; both take the same position.
    for (const element of array.message(2)?.messages(1) ?? []) {
      const position = order.get(
        identity(reference(element.message(1), `${key} redirect`)),
      );
      if (position !== undefined)
        order.set(
          identity(reference(element.message(2), `${key} redirect`)),
          position,
        );
    }
    return {
      order,
      count: array.message(1)?.messages(2).length ?? 0,
    };
  };
  const rows = positions('crRows');
  const columns = positions('crColumns');
  const direction = objects
    .flatMap((object) => {
      try {
        return [...entries(object, 'direction').values()];
      } catch {
        return [];
      }
    })
    .map((value) => value?.string(4))
    .find((value) => value?.startsWith('CRTableColumnDirection'));
  const grid = Array.from({ length: rows.count }, () =>
    Array<string>(columns.count).fill(''),
  );
  const cellColumns = reference(table.get('cellColumns'), 'cellColumns');
  for (const column of cellColumns.message(6)?.messages(1) ?? []) {
    const x = columns.order.get(
      identity(reference(column.message(1), 'column')),
    );
    const cells = reference(column.message(2), 'column rows').message(6);
    for (const cell of cells?.messages(1) ?? []) {
      const y = rows.order.get(identity(reference(cell.message(1), 'row')));
      const line = y === undefined ? undefined : grid[y];
      if (x === undefined || line === undefined)
        throw new TypeError('Notes table cell has no row or column position');
      const text = reference(cell.message(2), 'cell').message(10)?.string(2);
      line[x] = (text ?? '').replaceAll(attachmentCharacter, '');
    }
  }
  return direction === 'CRTableColumnDirectionRightToLeft'
    ? grid.map((row) => row.toReversed())
    : grid;
}
