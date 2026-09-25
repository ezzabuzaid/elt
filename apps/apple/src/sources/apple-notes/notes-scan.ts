import { dirname, join } from 'node:path';
import type { SQLOutputValue } from 'node:sqlite';
import {
  decodeTable,
  markdownTable,
  type NoteAttachmentReference,
  NoteDocument,
} from '../../platform/macos/note-document.ts';
import type { NoteStore } from '../../platform/macos/note-store.ts';

// Every Notes object lives in one Core Data table; Z_ENT names its entity, and
// each entity's relationships sit in their own numbered columns. These are the
// macOS 26 columns, checked against a live store; NoteStore.open refuses a
// store without them.
export const requiredColumns = {
  Z_PRIMARYKEY: ['Z_ENT', 'Z_NAME'],
  ZICNOTEDATA: ['Z_PK', 'ZDATA'],
  ZICLOCATION: ['ZATTACHMENT', 'ZLATITUDE', 'ZLONGITUDE'],
  ZICCLOUDSYNCINGOBJECT: [
    'Z_PK',
    'Z_ENT',
    'ZIDENTIFIER',
    'ZMARKEDFORDELETION',
    'ZNAME',
    'ZACCOUNTTYPE',
    'ZTITLE2',
    'ZACCOUNT8',
    'ZPARENT',
    'ZFOLDERTYPE',
    'ZSMARTFOLDERQUERYJSON',
    'ZSERVERSHAREDATA',
    'ZTITLE1',
    'ZACCOUNT7',
    'ZFOLDER',
    'ZNOTEDATA',
    'ZCREATIONDATE3',
    'ZMODIFICATIONDATE1',
    'ZISPINNED',
    'ZHASCHECKLIST',
    'ZHASCHECKLISTINPROGRESS',
    'ZISPASSWORDPROTECTED',
    'ZNOTE',
    'ZACCOUNT1',
    'ZMEDIA',
    'ZPARENTATTACHMENT',
    'ZTYPEUTI',
    'ZTITLE',
    'ZUSERTITLE',
    'ZURLSTRING',
    'ZSUMMARY',
    'ZOCRSUMMARY',
    'ZHANDWRITINGSUMMARY',
    'ZIMAGECLASSIFICATIONSUMMARY',
    'ZADDITIONALINDEXABLETEXT',
    'ZFILESIZE',
    'ZDURATION',
    'ZSIZEWIDTH',
    'ZSIZEHEIGHT',
    'ZCREATIONDATE',
    'ZMODIFICATIONDATE',
    'ZMERGEABLEDATA1',
    'ZFILENAME',
    'ZGENERATION1',
    'ZNOTE1',
    'ZTYPEUTI1',
    'ZALTTEXT',
    'ZTOKENCONTENTIDENTIFIER',
    'ZCREATIONDATE2',
  ],
} as const;

const entity = (name: string) =>
  `(SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = '${name}')`;
const live = (alias: string) => `coalesce(${alias}.ZMARKEDFORDELETION, 0) = 0`;

const accountsSql = `SELECT a.ZIDENTIFIER, a.ZNAME, a.ZACCOUNTTYPE
  FROM ZICCLOUDSYNCINGOBJECT a
  WHERE a.Z_ENT = ${entity('ICAccount')} AND ${live('a')}
  ORDER BY a.Z_PK`;

const foldersSql = `SELECT f.ZIDENTIFIER, a.ZIDENTIFIER AS account, p.ZIDENTIFIER AS parent, f.ZTITLE2, f.ZFOLDERTYPE, f.ZSMARTFOLDERQUERYJSON, f.ZSERVERSHAREDATA IS NOT NULL AS shared
  FROM ZICCLOUDSYNCINGOBJECT f
  JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = f.ZACCOUNT8
  LEFT JOIN ZICCLOUDSYNCINGOBJECT p ON p.Z_PK = f.ZPARENT
  WHERE f.Z_ENT = ${entity('ICFolder')} AND ${live('f')}
  ORDER BY f.Z_PK`;

// A note is real once it has a folder: notes Notes has not yet fetched from
// iCloud sit without one, titles or dates.
const notesSql = `SELECT n.Z_PK, n.ZIDENTIFIER, a.ZIDENTIFIER AS account, f.ZIDENTIFIER AS folder, n.ZTITLE1, n.ZCREATIONDATE3, n.ZMODIFICATIONDATE1, n.ZISPINNED, n.ZHASCHECKLIST, n.ZHASCHECKLISTINPROGRESS, n.ZISPASSWORDPROTECTED, n.ZSERVERSHAREDATA IS NOT NULL AS shared, d.ZDATA
  FROM ZICCLOUDSYNCINGOBJECT n
  JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER
  JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = n.ZACCOUNT7
  LEFT JOIN ZICNOTEDATA d ON d.Z_PK = n.ZNOTEDATA
  WHERE n.Z_ENT = ${entity('ICNote')} AND ${live('n')}
  ORDER BY n.Z_PK`;

// Gallery pages (scans) belong to the gallery attachment rather than a note.
const attachmentsSql = `SELECT t.ZIDENTIFIER, n.ZIDENTIFIER AS note, n.ZISPASSWORDPROTECTED AS locked, p.ZIDENTIFIER AS parent, t.ZTYPEUTI, coalesce(t.ZUSERTITLE, t.ZTITLE) AS title, m.ZFILENAME, t.ZURLSTRING, t.ZSUMMARY, t.ZOCRSUMMARY, t.ZHANDWRITINGSUMMARY, t.ZIMAGECLASSIFICATIONSUMMARY, t.ZADDITIONALINDEXABLETEXT, t.ZFILESIZE, t.ZDURATION, t.ZSIZEWIDTH, t.ZSIZEHEIGHT, l.ZLATITUDE, l.ZLONGITUDE, t.ZCREATIONDATE, t.ZMODIFICATIONDATE, t.ZMERGEABLEDATA1, a.ZIDENTIFIER AS account, m.ZIDENTIFIER AS media, m.ZGENERATION1
  FROM ZICCLOUDSYNCINGOBJECT t
  LEFT JOIN ZICCLOUDSYNCINGOBJECT p ON p.Z_PK = t.ZPARENTATTACHMENT
  JOIN ZICCLOUDSYNCINGOBJECT n ON n.Z_PK = coalesce(t.ZNOTE, p.ZNOTE)
  JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER
  JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = t.ZACCOUNT1
  LEFT JOIN ZICCLOUDSYNCINGOBJECT m ON m.Z_PK = t.ZMEDIA
  LEFT JOIN ZICLOCATION l ON l.ZATTACHMENT = t.Z_PK
  WHERE t.Z_ENT = ${entity('ICAttachment')} AND ${live('t')} AND ${live('n')}
  ORDER BY t.Z_PK`;

const inlineSql = `SELECT i.ZIDENTIFIER, n.ZIDENTIFIER AS note, i.ZTYPEUTI1, i.ZALTTEXT, i.ZTOKENCONTENTIDENTIFIER, i.ZCREATIONDATE2
  FROM ZICCLOUDSYNCINGOBJECT i
  JOIN ZICCLOUDSYNCINGOBJECT n ON n.Z_PK = i.ZNOTE1
  JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER
  WHERE i.Z_ENT = ${entity('ICInlineAttachment')} AND ${live('i')} AND ${live('n')}
  ORDER BY i.Z_PK`;

export type Row = Record<string, SQLOutputValue>;

const noteLinkType = 'com.apple.notes.inlinetextattachment.link';

const appleEpochSeconds = 978_307_200;

// Core Data stores dates as seconds since 2001-01-01.
export const time = (value: SQLOutputValue | undefined) =>
  typeof value === 'number'
    ? new Date(Math.round((value + appleEpochSeconds) * 1000)).toISOString()
    : null;

export const string = (value: SQLOutputValue | undefined) =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

export const number = (value: SQLOutputValue | undefined) =>
  typeof value === 'number' ? value : null;

export const flag = (value: SQLOutputValue | undefined) => value === 1;

export type NoteEntry = {
  readonly row: Row;
  readonly document: NoteDocument | null;
};

// One run's read of the store: every stream reads through it, each query runs
// once, and note bodies and tables are decoded once however many streams use
// them. Disposing it ends the store's read transaction.
export class NotesScan implements AsyncDisposable {
  #accounts?: Row[];
  #folders?: Row[];
  #notes?: NoteEntry[];
  #attachments?: Map<SQLOutputValue | undefined, Row>;
  #inline?: Map<SQLOutputValue | undefined, Row>;
  readonly #tables = new Map<string, string[][]>();

  constructor(readonly store: NoteStore) {}

  [Symbol.asyncDispose](): Promise<void> {
    return this.store[Symbol.asyncDispose]();
  }

  get accounts(): Row[] {
    this.#accounts ??= this.store.all(accountsSql);
    return this.#accounts;
  }

  get folders(): Row[] {
    this.#folders ??= this.store.all(foldersSql);
    return this.#folders;
  }

  get notes(): NoteEntry[] {
    this.#notes ??= this.store.all(notesSql).map((row) => ({
      row,
      document:
        row.ZISPASSWORDPROTECTED === 1 || !(row.ZDATA instanceof Uint8Array)
          ? null
          : NoteDocument.decode(row.ZDATA),
    }));
    return this.#notes;
  }

  // Attachments and inline attachments by identifier, in store order.
  get attachments(): ReadonlyMap<SQLOutputValue | undefined, Row> {
    this.#attachments ??= new Map(
      this.store.all(attachmentsSql).map((row) => [row.ZIDENTIFIER, row]),
    );
    return this.#attachments;
  }

  get inline(): ReadonlyMap<SQLOutputValue | undefined, Row> {
    this.#inline ??= new Map(
      this.store.all(inlineSql).map((row) => [row.ZIDENTIFIER, row]),
    );
    return this.#inline;
  }

  table(row: Row): string[][] | null {
    if (
      row.ZTYPEUTI !== 'com.apple.notes.table' ||
      row.locked === 1 ||
      !(row.ZMERGEABLEDATA1 instanceof Uint8Array)
    )
      return null;
    const key = String(row.ZIDENTIFIER);
    let grid = this.#tables.get(key);
    if (grid === undefined) {
      grid = decodeTable(row.ZMERGEABLEDATA1);
      this.#tables.set(key, grid);
    }
    return grid;
  }

  // The original file under the account's Media directory.
  file(row: Row): string | null {
    if (
      row.locked === 1 ||
      typeof row.account !== 'string' ||
      typeof row.media !== 'string' ||
      typeof row.ZFILENAME !== 'string'
    )
      return null;
    return join(
      dirname(this.store.path),
      'Accounts',
      row.account,
      'Media',
      row.media,
      ...(typeof row.ZGENERATION1 === 'string' ? [row.ZGENERATION1] : []),
      row.ZFILENAME,
    );
  }

  // Plain text keeps what reads as text: inline tags and mentions.
  text(document: NoteDocument): string {
    return document.plain(
      ({ id }) => string(this.inline.get(id)?.ZALTTEXT) ?? '',
    );
  }

  markdown(document: NoteDocument): string {
    return document.markdown(({ id, type }: NoteAttachmentReference) => {
      const token = this.inline.get(id);
      if (token !== undefined) {
        const text = String(token.ZALTTEXT ?? '');
        const target = string(token.ZTOKENCONTENTIDENTIFIER);
        // A link to another note points at its applenotes: URL.
        return token.ZTYPEUTI1 === noteLinkType && target !== null
          ? `[${text}](<${target}>)`
          : text;
      }
      const row = this.attachments.get(id);
      if (row === undefined) return '';
      const grid = this.table(row);
      if (grid !== null) return `\n${markdownTable(grid)}\n`;
      const label = string(row.title) ?? string(row.ZFILENAME) ?? type ?? id;
      const url = string(row.ZURLSTRING);
      return url === null
        ? `[${label}](attachment:${id})`
        : `[${label}](<${url}>)`;
    });
  }
}
