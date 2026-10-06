import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SQLOutputValue } from 'node:sqlite';

import { AppDatabase } from '@workspace/sdk-apple-app-database';

import { NotesSchemaError, NotesUnavailableError } from './errors.ts';
import { NoteDocument, decodeTable } from './note-document.ts';

// Every Notes object lives in one Core Data table; Z_ENT names its entity, and
// each entity's relationships sit in their own numbered columns. These are the
// macOS 26 columns, checked against a live store; a snapshot refuses a store
// without them.
const requiredColumns = {
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

type Row = Record<string, SQLOutputValue>;

const appleEpochSeconds = 978_307_200;

// Core Data stores dates as seconds since 2001-01-01.
const time = (value: SQLOutputValue | undefined) =>
  typeof value === 'number'
    ? new Date(Math.round((value + appleEpochSeconds) * 1000))
    : null;

const text = (value: SQLOutputValue | undefined) =>
  typeof value === 'string' ? value : null;

const number = (value: SQLOutputValue | undefined) =>
  typeof value === 'number' ? value : null;

const flag = (value: SQLOutputValue | undefined) => value === 1;

export type NoteAccount = {
  readonly id: string | null;
  readonly name: string | null;
  readonly type: number | null;
};

export type NoteFolder = {
  readonly id: string | null;
  readonly accountId: string | null;
  readonly parentId: string | null;
  readonly name: string | null;
  // 1 is Recently Deleted.
  readonly type: number | null;
  // The smart-folder query as Notes stores it, as JSON text.
  readonly smartQuery: string | null;
  readonly shared: boolean;
};

// A note that has a folder: one Notes has not yet fetched from iCloud has
// none. A locked note's body is encrypted; it keeps its title, dates and flags.
export type Note = {
  readonly id: string | null;
  readonly accountId: string | null;
  readonly folderId: string | null;
  readonly title: string | null;
  readonly createdAt: Date | null;
  readonly modifiedAt: Date | null;
  readonly pinned: boolean;
  readonly hasChecklist: boolean;
  readonly checklistInProgress: boolean;
  readonly locked: boolean;
  readonly shared: boolean;
  // The body, decoded when asked; null when the note is locked or has none.
  document(): NoteDocument | null;
};

// An attachment of a note, or of a scan gallery in a note. Its file, table
// and media are encrypted when the note is locked.
export type NoteAttachment = {
  readonly id: string | null;
  readonly noteId: string | null;
  readonly parentId: string | null;
  readonly locked: boolean;
  readonly type: string | null;
  // The user's title, or the stored one when the user gave none.
  readonly title: string | null;
  readonly filename: string | null;
  readonly url: string | null;
  readonly summary: string | null;
  readonly ocrSummary: string | null;
  readonly handwritingSummary: string | null;
  readonly imageClassificationSummary: string | null;
  // Text Notes indexes besides the rest, such as an audio transcript.
  readonly indexableText: string | null;
  readonly fileSize: number | null;
  readonly duration: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly createdAt: Date | null;
  readonly modifiedAt: Date | null;
  // The original file under the account's Media directory; null when the
  // note is locked or the attachment has no media file.
  readonly file: string | null;
  // Whether that file is reachable now; false for a file not downloaded.
  availableLocally(): Promise<boolean>;
  // A table's rows × columns of cell text, decoded when asked; null for any
  // other attachment or when the note is locked.
  table(): string[][] | null;
};

// A tag, mention, note link or calculation inline in a note's text.
export type InlineAttachment = {
  readonly id: string | null;
  readonly noteId: string | null;
  readonly type: string | null;
  // The text Notes shows, such as #travel.
  readonly altText: string | null;
  // What it refers to, such as a normalized tag name or an applenotes: URL.
  readonly target: string | null;
  readonly createdAt: Date | null;
};

const tableType = 'com.apple.notes.table';

// A read-only view of NoteStore.sqlite pinned to one moment, so notes, their
// attachments and folders agree. Hold it only while reading: an open read
// stops Notes checkpointing its WAL.
export class NoteStoreSnapshot implements Disposable {
  readonly #path: string;
  readonly #database: AppDatabase;

  constructor(path: string) {
    this.#path = path;
    this.#database = new AppDatabase(path, NotesUnavailableError);
    this.#database.requireColumns(requiredColumns, NotesSchemaError);
  }

  accounts(): NoteAccount[] {
    return this.#database.all(accountsSql).map((row) => ({
      id: text(row.ZIDENTIFIER),
      name: text(row.ZNAME),
      type: number(row.ZACCOUNTTYPE),
    }));
  }

  folders(): NoteFolder[] {
    return this.#database.all(foldersSql).map((row) => ({
      id: text(row.ZIDENTIFIER),
      accountId: text(row.account),
      parentId: text(row.parent),
      name: text(row.ZTITLE2),
      type: number(row.ZFOLDERTYPE),
      smartQuery: text(row.ZSMARTFOLDERQUERYJSON),
      shared: flag(row.shared),
    }));
  }

  notes(): Note[] {
    return this.#database.all(notesSql).map((row) => {
      const locked = flag(row.ZISPASSWORDPROTECTED);
      const data = row.ZDATA;
      return {
        id: text(row.ZIDENTIFIER),
        accountId: text(row.account),
        folderId: text(row.folder),
        title: text(row.ZTITLE1),
        createdAt: time(row.ZCREATIONDATE3),
        modifiedAt: time(row.ZMODIFICATIONDATE1),
        pinned: flag(row.ZISPINNED),
        hasChecklist: flag(row.ZHASCHECKLIST),
        checklistInProgress: flag(row.ZHASCHECKLISTINPROGRESS),
        locked,
        shared: flag(row.shared),
        document: () =>
          locked || !(data instanceof Uint8Array)
            ? null
            : NoteDocument.decode(data),
      };
    });
  }

  attachments(): NoteAttachment[] {
    return this.#database.all(attachmentsSql).map((row) => {
      const locked = flag(row.locked);
      const file = this.#file(row, locked);
      const data = row.ZMERGEABLEDATA1;
      return {
        id: text(row.ZIDENTIFIER),
        noteId: text(row.note),
        parentId: text(row.parent),
        locked,
        type: text(row.ZTYPEUTI),
        title: text(row.title),
        filename: text(row.ZFILENAME),
        url: text(row.ZURLSTRING),
        summary: text(row.ZSUMMARY),
        ocrSummary: text(row.ZOCRSUMMARY),
        handwritingSummary: text(row.ZHANDWRITINGSUMMARY),
        imageClassificationSummary: text(row.ZIMAGECLASSIFICATIONSUMMARY),
        indexableText: text(row.ZADDITIONALINDEXABLETEXT),
        fileSize: number(row.ZFILESIZE),
        duration: number(row.ZDURATION),
        width: number(row.ZSIZEWIDTH),
        height: number(row.ZSIZEHEIGHT),
        latitude: number(row.ZLATITUDE),
        longitude: number(row.ZLONGITUDE),
        createdAt: time(row.ZCREATIONDATE),
        modifiedAt: time(row.ZMODIFICATIONDATE),
        file,
        availableLocally: async () =>
          file !== null &&
          access(file).then(
            () => true,
            () => false,
          ),
        table: () =>
          row.ZTYPEUTI !== tableType || locked || !(data instanceof Uint8Array)
            ? null
            : decodeTable(data),
      };
    });
  }

  inlineAttachments(): InlineAttachment[] {
    return this.#database.all(inlineSql).map((row) => ({
      id: text(row.ZIDENTIFIER),
      noteId: text(row.note),
      type: text(row.ZTYPEUTI1),
      altText: text(row.ZALTTEXT),
      target: text(row.ZTOKENCONTENTIDENTIFIER),
      createdAt: time(row.ZCREATIONDATE2),
    }));
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }

  // <store directory>/Accounts/<account>/Media/<media>/[<generation>/]<filename>
  #file(row: Row, locked: boolean): string | null {
    if (
      locked ||
      typeof row.account !== 'string' ||
      typeof row.media !== 'string' ||
      typeof row.ZFILENAME !== 'string'
    )
      return null;
    return join(
      dirname(this.#path),
      'Accounts',
      row.account,
      'Media',
      row.media,
      ...(typeof row.ZGENERATION1 === 'string' ? [row.ZGENERATION1] : []),
      row.ZFILENAME,
    );
  }
}
