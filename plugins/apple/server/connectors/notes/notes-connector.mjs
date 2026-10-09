import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  ProtobufMessage
} from "../../chunks/chunk-QMS7KGTZ.mjs";
import {
  accounts,
  collections,
  name
} from "../../chunks/chunk-FGFSL4M6.mjs";
import {
  selected,
  withinDates
} from "../../chunks/chunk-YM7ADF2O.mjs";
import {
  localAppleStoreCoverage
} from "../../chunks/chunk-BRJ4TKR5.mjs";
import {
  AppDatabase,
  AppDatabaseVersion
} from "../../chunks/chunk-SDFTRGL6.mjs";
import {
  eventKitFields
} from "../../chunks/chunk-YUEL2AIL.mjs";
import {
  AppleConnector
} from "../../chunks/chunk-TI6UOZR6.mjs";
import {
  Catalog,
  Source,
  Stream,
  diffSnapshot,
  validateRecords
} from "../../chunks/chunk-L4HYJU4U.mjs";
import {
  __callDispose,
  __using
} from "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/sources/apple/notes/dist/apple-notes-source.js
import { setInterval } from "node:timers/promises";

// packages/sdks/apple/notes/dist/errors.js
var NotesUnavailableError = class extends Error {
  name = "NotesUnavailableError";
  constructor(path, cause) {
    super(`The Notes store at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Notes.app does not need to be open.`, { cause });
  }
};
var NotesSchemaError = class extends Error {
  name = "NotesSchemaError";
  constructor(path, missing) {
    super(`The Notes store at ${path} has a layout this reader does not read (missing ${missing.join(", ")}).`);
  }
};

// packages/sdks/apple/notes/dist/note-document.js
import { gunzipSync, inflateSync } from "node:zlib";
var decompress = (bytes) => bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes) : inflateSync(bytes);
var versionData = (bytes) => {
  const data = new ProtobufMessage(decompress(bytes)).messages(2).at(-1)?.bytes(3);
  if (data === void 0)
    throw new TypeError("Notes document has no version data");
  return new ProtobufMessage(data);
};
var uuid = (bytes) => Buffer.from(bytes).toString("hex");
var paragraphStyles = /* @__PURE__ */ new Map([
  [0, "title"],
  [1, "heading"],
  [2, "subheading"],
  [4, "monospaced"],
  [100, "bullet"],
  [101, "dash"],
  [102, "numbered"],
  [103, "checklist"]
]);
var attachmentCharacter = "\uFFFC";
var NoteDocument = class _NoteDocument {
  paragraphs;
  constructor(paragraphs) {
    this.paragraphs = paragraphs;
  }
  static decode(bytes) {
    const note = versionData(bytes);
    const text6 = note.string(2) ?? "";
    const paragraphs = [];
    let current = [];
    let style;
    let offset = 0;
    const close = () => {
      const todo = style?.message(5);
      paragraphs.push({
        style: paragraphStyles.get(style?.uint(1)) ?? "body",
        indent: style?.uint(4) ?? 0,
        blockQuote: style?.uint(8) ?? 0,
        startNumber: style?.uint(7),
        todo: todo === void 0 ? void 0 : {
          id: uuid(todo.bytes(1) ?? new Uint8Array()),
          done: todo.uint(2) === 1
        },
        runs: current
      });
      current = [];
      style = void 0;
    };
    for (const run of note.messages(5)) {
      const length = run.uint(1) ?? 0;
      const segment = text6.slice(offset, offset + length);
      offset += length;
      const hints = run.uint(5) ?? 0;
      const attachment = run.message(12);
      const base = {
        bold: (hints & 1) !== 0,
        italic: (hints & 2) !== 0,
        strikethrough: (run.uint(7) ?? 0) !== 0,
        link: run.string(9) ?? null,
        attachment: attachment === void 0 ? null : {
          id: attachment.string(1) ?? "",
          type: attachment.string(2) ?? null
        }
      };
      const lines = segment.split("\n");
      lines.forEach((line, index) => {
        if (line !== "")
          current.push({ ...base, text: line });
        style = run.message(2);
        if (index < lines.length - 1)
          close();
      });
    }
    if (offset < text6.length)
      current.push({
        text: text6.slice(offset),
        bold: false,
        italic: false,
        strikethrough: false,
        link: null,
        attachment: null
      });
    if (current.length > 0)
      close();
    return new _NoteDocument(paragraphs);
  }
};
function decodeTable(bytes) {
  const document = versionData(bytes);
  const objects = document.messages(3);
  const keys = document.strings(4);
  const uuidItems = document.bytesList(6);
  const reference = (id6, label) => {
    const index = id6?.uint(6);
    const object = index === void 0 ? void 0 : objects[index];
    if (object === void 0)
      throw new TypeError(`Notes table ${label} is not an object reference`);
    return object;
  };
  const entries = (object, label) => {
    const custom = object.message(13);
    if (custom === void 0)
      throw new TypeError(`Notes table ${label} is not a keyed object`);
    return new Map(custom.messages(3).map((entry) => [keys[entry.uint(1) ?? -1], entry.message(2)]));
  };
  const table = entries(objects[0] ?? reference(void 0, "root"), "root");
  const identity = (object) => {
    const index = entries(object, "identity").get("UUIDIndex")?.uint(2);
    if (index === void 0)
      throw new TypeError("Notes table identity has no UUID index");
    return index;
  };
  const positions = (key) => {
    const set = reference(table.get(key), key).message(16);
    const array = set?.message(1);
    if (array === void 0)
      throw new TypeError(`Notes table ${key} is not an ordered set`);
    const order = /* @__PURE__ */ new Map();
    (array.message(1)?.messages(2) ?? []).forEach((entry, position) => {
      const id6 = entry.bytes(2);
      const index = uuidItems.findIndex((item) => id6 !== void 0 && Buffer.from(item).equals(id6));
      if (index === -1)
        throw new TypeError(`Notes table ${key} names an unknown identity`);
      order.set(index, position);
    });
    for (const element of array.message(2)?.messages(1) ?? []) {
      const position = order.get(identity(reference(element.message(1), `${key} redirect`)));
      if (position !== void 0)
        order.set(identity(reference(element.message(2), `${key} redirect`)), position);
    }
    return {
      order,
      count: array.message(1)?.messages(2).length ?? 0
    };
  };
  const rows = positions("crRows");
  const columns = positions("crColumns");
  const direction = objects.flatMap((object) => {
    try {
      return [...entries(object, "direction").values()];
    } catch {
      return [];
    }
  }).map((value) => value?.string(4)).find((value) => value?.startsWith("CRTableColumnDirection"));
  const grid = Array.from({ length: rows.count }, () => Array(columns.count).fill(""));
  const cellColumns = reference(table.get("cellColumns"), "cellColumns");
  for (const column of cellColumns.message(6)?.messages(1) ?? []) {
    const x = columns.order.get(identity(reference(column.message(1), "column")));
    const cells = reference(column.message(2), "column rows").message(6);
    for (const cell of cells?.messages(1) ?? []) {
      const y = rows.order.get(identity(reference(cell.message(1), "row")));
      const line = y === void 0 ? void 0 : grid[y];
      if (x === void 0 || line === void 0)
        throw new TypeError("Notes table cell has no row or column position");
      const text6 = reference(cell.message(2), "cell").message(10)?.string(2);
      line[x] = (text6 ?? "").replaceAll(attachmentCharacter, "");
    }
  }
  return direction === "CRTableColumnDirectionRightToLeft" ? grid.map((row) => row.toReversed()) : grid;
}

// packages/sdks/apple/notes/dist/note-store.js
import { homedir } from "node:os";
import { join as join2 } from "node:path";

// packages/sdks/apple/notes/dist/note-store-snapshot.js
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
var requiredColumns = {
  Z_PRIMARYKEY: ["Z_ENT", "Z_NAME"],
  ZICNOTEDATA: ["Z_PK", "ZDATA"],
  ZICLOCATION: ["ZATTACHMENT", "ZLATITUDE", "ZLONGITUDE"],
  ZICCLOUDSYNCINGOBJECT: [
    "Z_PK",
    "Z_ENT",
    "ZIDENTIFIER",
    "ZMARKEDFORDELETION",
    "ZNAME",
    "ZACCOUNTTYPE",
    "ZTITLE2",
    "ZACCOUNT8",
    "ZPARENT",
    "ZFOLDERTYPE",
    "ZSMARTFOLDERQUERYJSON",
    "ZSERVERSHAREDATA",
    "ZTITLE1",
    "ZACCOUNT7",
    "ZFOLDER",
    "ZNOTEDATA",
    "ZCREATIONDATE3",
    "ZMODIFICATIONDATE1",
    "ZISPINNED",
    "ZHASCHECKLIST",
    "ZHASCHECKLISTINPROGRESS",
    "ZISPASSWORDPROTECTED",
    "ZNOTE",
    "ZACCOUNT1",
    "ZMEDIA",
    "ZPARENTATTACHMENT",
    "ZTYPEUTI",
    "ZTITLE",
    "ZUSERTITLE",
    "ZURLSTRING",
    "ZSUMMARY",
    "ZOCRSUMMARY",
    "ZHANDWRITINGSUMMARY",
    "ZIMAGECLASSIFICATIONSUMMARY",
    "ZADDITIONALINDEXABLETEXT",
    "ZFILESIZE",
    "ZDURATION",
    "ZSIZEWIDTH",
    "ZSIZEHEIGHT",
    "ZCREATIONDATE",
    "ZMODIFICATIONDATE",
    "ZMERGEABLEDATA1",
    "ZFILENAME",
    "ZGENERATION1",
    "ZNOTE1",
    "ZTYPEUTI1",
    "ZALTTEXT",
    "ZTOKENCONTENTIDENTIFIER",
    "ZCREATIONDATE2"
  ]
};
var entity = (name2) => `(SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = '${name2}')`;
var live = (alias) => `coalesce(${alias}.ZMARKEDFORDELETION, 0) = 0`;
var accountsSql = `SELECT a.ZIDENTIFIER, a.ZNAME, a.ZACCOUNTTYPE
  FROM ZICCLOUDSYNCINGOBJECT a
  WHERE a.Z_ENT = ${entity("ICAccount")} AND ${live("a")}
  ORDER BY a.Z_PK`;
var foldersSql = `SELECT f.ZIDENTIFIER, a.ZIDENTIFIER AS account, p.ZIDENTIFIER AS parent, f.ZTITLE2, f.ZFOLDERTYPE, f.ZSMARTFOLDERQUERYJSON, f.ZSERVERSHAREDATA IS NOT NULL AS shared
  FROM ZICCLOUDSYNCINGOBJECT f
  JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = f.ZACCOUNT8
  LEFT JOIN ZICCLOUDSYNCINGOBJECT p ON p.Z_PK = f.ZPARENT
  WHERE f.Z_ENT = ${entity("ICFolder")} AND ${live("f")}
  ORDER BY f.Z_PK`;
var notesSql = `SELECT n.Z_PK, n.ZIDENTIFIER, a.ZIDENTIFIER AS account, f.ZIDENTIFIER AS folder, n.ZTITLE1, n.ZCREATIONDATE3, n.ZMODIFICATIONDATE1, n.ZISPINNED, n.ZHASCHECKLIST, n.ZHASCHECKLISTINPROGRESS, n.ZISPASSWORDPROTECTED, n.ZSERVERSHAREDATA IS NOT NULL AS shared, d.ZDATA
  FROM ZICCLOUDSYNCINGOBJECT n
  JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER
  JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = n.ZACCOUNT7
  LEFT JOIN ZICNOTEDATA d ON d.Z_PK = n.ZNOTEDATA
  WHERE n.Z_ENT = ${entity("ICNote")} AND ${live("n")}
  ORDER BY n.Z_PK`;
var attachmentsSql = `SELECT t.ZIDENTIFIER, n.ZIDENTIFIER AS note, n.ZISPASSWORDPROTECTED AS locked, p.ZIDENTIFIER AS parent, t.ZTYPEUTI, coalesce(t.ZUSERTITLE, t.ZTITLE) AS title, m.ZFILENAME, t.ZURLSTRING, t.ZSUMMARY, t.ZOCRSUMMARY, t.ZHANDWRITINGSUMMARY, t.ZIMAGECLASSIFICATIONSUMMARY, t.ZADDITIONALINDEXABLETEXT, t.ZFILESIZE, t.ZDURATION, t.ZSIZEWIDTH, t.ZSIZEHEIGHT, l.ZLATITUDE, l.ZLONGITUDE, t.ZCREATIONDATE, t.ZMODIFICATIONDATE, t.ZMERGEABLEDATA1, a.ZIDENTIFIER AS account, m.ZIDENTIFIER AS media, m.ZGENERATION1
  FROM ZICCLOUDSYNCINGOBJECT t
  LEFT JOIN ZICCLOUDSYNCINGOBJECT p ON p.Z_PK = t.ZPARENTATTACHMENT
  JOIN ZICCLOUDSYNCINGOBJECT n ON n.Z_PK = coalesce(t.ZNOTE, p.ZNOTE)
  JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER
  JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = t.ZACCOUNT1
  LEFT JOIN ZICCLOUDSYNCINGOBJECT m ON m.Z_PK = t.ZMEDIA
  LEFT JOIN ZICLOCATION l ON l.ZATTACHMENT = t.Z_PK
  WHERE t.Z_ENT = ${entity("ICAttachment")} AND ${live("t")} AND ${live("n")}
  ORDER BY t.Z_PK`;
var inlineSql = `SELECT i.ZIDENTIFIER, n.ZIDENTIFIER AS note, i.ZTYPEUTI1, i.ZALTTEXT, i.ZTOKENCONTENTIDENTIFIER, i.ZCREATIONDATE2
  FROM ZICCLOUDSYNCINGOBJECT i
  JOIN ZICCLOUDSYNCINGOBJECT n ON n.Z_PK = i.ZNOTE1
  JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER
  WHERE i.Z_ENT = ${entity("ICInlineAttachment")} AND ${live("i")} AND ${live("n")}
  ORDER BY i.Z_PK`;
var appleEpochSeconds = 978307200;
var time = (value) => typeof value === "number" ? new Date(Math.round((value + appleEpochSeconds) * 1e3)) : null;
var text = (value) => typeof value === "string" ? value : null;
var number = (value) => typeof value === "number" ? value : null;
var flag = (value) => value === 1;
var tableType = "com.apple.notes.table";
var NoteStoreSnapshot = class {
  #path;
  #database;
  constructor(path) {
    this.#path = path;
    this.#database = new AppDatabase(path, NotesUnavailableError);
    this.#database.requireColumns(requiredColumns, NotesSchemaError);
  }
  accounts() {
    return this.#database.all(accountsSql).map((row) => ({
      id: text(row.ZIDENTIFIER),
      name: text(row.ZNAME),
      type: number(row.ZACCOUNTTYPE)
    }));
  }
  folders() {
    return this.#database.all(foldersSql).map((row) => ({
      id: text(row.ZIDENTIFIER),
      accountId: text(row.account),
      parentId: text(row.parent),
      name: text(row.ZTITLE2),
      type: number(row.ZFOLDERTYPE),
      smartQuery: text(row.ZSMARTFOLDERQUERYJSON),
      shared: flag(row.shared)
    }));
  }
  notes() {
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
        document: () => locked || !(data instanceof Uint8Array) ? null : NoteDocument.decode(data)
      };
    });
  }
  attachments() {
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
        availableLocally: async () => file !== null && access(file).then(() => true, () => false),
        table: () => row.ZTYPEUTI !== tableType || locked || !(data instanceof Uint8Array) ? null : decodeTable(data)
      };
    });
  }
  inlineAttachments() {
    return this.#database.all(inlineSql).map((row) => ({
      id: text(row.ZIDENTIFIER),
      noteId: text(row.note),
      type: text(row.ZTYPEUTI1),
      altText: text(row.ZALTTEXT),
      target: text(row.ZTOKENCONTENTIDENTIFIER),
      createdAt: time(row.ZCREATIONDATE2)
    }));
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
  // <store directory>/Accounts/<account>/Media/<media>/[<generation>/]<filename>
  #file(row, locked) {
    if (locked || typeof row.account !== "string" || typeof row.media !== "string" || typeof row.ZFILENAME !== "string")
      return null;
    return join(dirname(this.#path), "Accounts", row.account, "Media", row.media, ...typeof row.ZGENERATION1 === "string" ? [row.ZGENERATION1] : [], row.ZFILENAME);
  }
};

// packages/sdks/apple/notes/dist/note-store.js
var noteStorePath = join2(homedir(), "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite");
var NotesStore = class {
  #path;
  constructor(path) {
    this.#path = path;
  }
  // The store as of one moment, so notes, their attachments and folders
  // agree.
  open() {
    return new NoteStoreSnapshot(this.#path);
  }
  // Notes keeps NoteStore.sqlite and its WAL open while it runs; this probe
  // changes with each commit Notes makes.
  version() {
    return new AppDatabaseVersion(this.#path, NotesUnavailableError);
  }
};

// packages/sdks/apple/notes/dist/notes-app.js
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
var execFile = promisify(execFileCallback);
var bundle = "com.apple.Notes";
async function launchNotesHidden() {
  const { stdout } = await execFile("/usr/bin/lsappinfo", [
    "info",
    "-only",
    "pid",
    "-app",
    bundle
  ]);
  if (/\bpid"?\s*=\s*\d+/.test(stdout))
    return false;
  await execFile("/usr/bin/open", ["-g", "-j", "-b", bundle]);
  return true;
}

// packages/sources/apple/notes/dist/apple-notes-stream.js
var notesFields = {
  ...eventKitFields,
  nullableId: { type: ["string", "null"], minLength: 1 },
  nullableNumber: { type: ["number", "null"] }
};
var AppleNotesStream = class {
  primaryKey = ["id"];
  supportedSyncModes = Object.freeze([
    "full_refresh",
    "incremental"
  ]);
  // Every read is the whole store, so incremental copies diff snapshots.
  sourceDefinedCursor = true;
  emitsDeletes = true;
  #stream;
  describe() {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }
  async read(scan) {
    const records = await Promise.all(this.rows(scan).map((row) => this.record(row, scan)));
    return validateRecords(this, records, "Notes");
  }
  // The file a record carries, for streams that support file reads.
  file(_record, _scan) {
    return null;
  }
};

// packages/sources/apple/notes/dist/accounts-stream.js
var { id, text: text2, ordinal } = notesFields;
var properties = {
  id: {
    ...id,
    description: "Notes account identifier; referenced by the accountId fields of other streams from this source."
  },
  name: { ...text2, description: "Account name displayed by Notes." },
  type: {
    ...ordinal,
    description: "Numeric account type stored by Notes; an opaque category, not a quantity."
  }
};
var AccountsStream = class extends AppleNotesStream {
  name = "accounts";
  jsonSchema = {
    type: "object",
    description: "One source record per account in the local Notes store, excluding accounts marked for deletion. This is what Notes has synced to this Mac.",
    properties,
    required: Object.keys(properties)
  };
  rows(scan) {
    return scan.accounts;
  }
  record(account) {
    return { id: account.id, name: account.name, type: account.type };
  }
};

// packages/sources/apple/notes/dist/note-markdown.js
function plainText(document, attachment) {
  return document.paragraphs.map((paragraph) => paragraph.runs.map(({ text: text6, attachment: reference }) => reference === null ? text6 : text6.replaceAll(attachmentCharacter, () => attachment(reference))).join("")).join("\n");
}
function markdown(document, attachment) {
  const lines = [];
  const numbers = [];
  let monospaced = false;
  for (const paragraph of document.paragraphs) {
    const code = paragraph.style === "monospaced";
    if (code !== monospaced) {
      lines.push("```");
      monospaced = code;
    }
    if (code) {
      lines.push(plain(paragraph));
      continue;
    }
    const numbered = paragraph.style === "numbered";
    numbers.length = numbered ? paragraph.indent + 1 : 0;
    if (numbered)
      numbers[paragraph.indent] = paragraph.startNumber ?? (numbers[paragraph.indent] ?? 0) + 1;
    const heading = paragraph.style === "title" || paragraph.style === "heading" || paragraph.style === "subheading";
    const content = merge(heading ? paragraph.runs.map((run) => ({ ...run, bold: false })) : paragraph.runs).map((run) => inline(run, attachment)).join("");
    if (content === "") {
      lines.push("");
      continue;
    }
    const quote = "> ".repeat(paragraph.blockQuote);
    const prefix = linePrefix(paragraph, numbers[paragraph.indent]);
    lines.push(`${quote}${prefix}${prefix === "" ? escapeLineStart(content) : content}`);
  }
  if (monospaced)
    lines.push("```");
  return lines.join("\n");
}
function linePrefix(paragraph, number2) {
  const indent = "  ".repeat(paragraph.indent);
  switch (paragraph.style) {
    case "title":
      return "# ";
    case "heading":
      return "## ";
    case "subheading":
      return "### ";
    case "bullet":
    case "dash":
      return `${indent}- `;
    case "numbered":
      return `${indent}${number2}. `;
    case "checklist":
      return `${indent}- [${paragraph.todo?.done ? "x" : " "}] `;
    default:
      return "";
  }
}
var plain = (paragraph) => paragraph.runs.map((run) => run.text).join("").replaceAll(attachmentCharacter, "");
var merge = (runs) => runs.reduce((merged, run) => {
  const previous = merged.at(-1);
  if (previous !== void 0 && previous.attachment === null && run.attachment === null && previous.bold === run.bold && previous.italic === run.italic && previous.strikethrough === run.strikethrough && previous.link === run.link)
    merged[merged.length - 1] = {
      ...previous,
      text: previous.text + run.text
    };
  else
    merged.push(run);
  return merged;
}, []);
var escapeInline = (text6) => text6.replace(/[\\`*_[\]~<]/g, "\\$&");
var escapeLineStart = (line) => line.replace(/^(\s*)([#>+-]|\d+[.)])(?=\s|$)/, "$1\\$2");
var inline = (run, attachment) => {
  const { attachment: reference } = run;
  if (reference !== null)
    return run.text.split("").map((character) => character === attachmentCharacter ? attachment(reference) : escapeInline(character)).join("");
  const text6 = run.text.trim();
  if (text6 === "")
    return run.text;
  let body = escapeInline(text6);
  if (run.strikethrough)
    body = `~~${body}~~`;
  if (run.bold && run.italic)
    body = `***${body}***`;
  else if (run.bold)
    body = `**${body}**`;
  else if (run.italic)
    body = `*${body}*`;
  if (run.link !== null)
    body = `[${body}](<${run.link}>)`;
  const leading = run.text.slice(0, run.text.length - run.text.trimStart().length);
  const trailing = run.text.slice(run.text.trimEnd().length);
  return `${leading}${body}${trailing}`;
};
function markdownTable(grid) {
  if (grid.length === 0)
    return "";
  const cell = (text6) => escapeInline(text6).replaceAll("|", "\\|").replaceAll("\n", "<br>");
  const row = (cells) => `| ${cells.map(cell).join(" | ")} |`;
  const [header = [], ...body] = grid;
  return [
    row(header),
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map(row)
  ].join("\n");
}

// packages/sources/apple/notes/dist/notes-scan.js
var noteLinkType = "com.apple.notes.inlinetextattachment.link";
var string = (value) => value !== null && value.trim() !== "" ? value : null;
var NotesScan = class {
  #accounts;
  #folders;
  #notes;
  #attachments;
  #inline;
  #snapshot;
  #scope;
  constructor(snapshot, scope = {}) {
    this.#snapshot = snapshot;
    this.#scope = scope;
  }
  async [Symbol.asyncDispose]() {
    this.#snapshot[Symbol.dispose]();
  }
  // A folder scope keeps only the accounts that own a selected folder.
  get accounts() {
    this.#accounts ??= this.#snapshot.accounts().filter((account) => selected(this.#scope.accountIds, account.id) && (this.#scope.collectionIds === void 0 || this.folders.some((folder) => folder.accountId === account.id)));
    return this.#accounts;
  }
  get folders() {
    this.#folders ??= this.#snapshot.folders().filter((folder) => selected(this.#scope.accountIds, folder.accountId) && selected(this.#scope.collectionIds, folder.id));
    return this.#folders;
  }
  get notes() {
    this.#notes ??= this.#snapshot.notes().filter((note) => selected(this.#scope.accountIds, note.accountId) && selected(this.#scope.collectionIds, note.folderId) && withinDates(this.#scope, note.modifiedAt?.toISOString() ?? null));
    return this.#notes;
  }
  // Attachments and inline attachments of the notes in scope, by identifier,
  // in store order. An attachment the store lists once per location keeps
  // one entry.
  get attachments() {
    if (this.#attachments !== void 0)
      return this.#attachments;
    const notes = new Set(this.notes.map((note) => note.id));
    this.#attachments = new Map(this.#snapshot.attachments().filter((attachment) => notes.has(attachment.noteId)).map((attachment) => [attachment.id, attachment]));
    return this.#attachments;
  }
  get inline() {
    if (this.#inline !== void 0)
      return this.#inline;
    const notes = new Set(this.notes.map((note) => note.id));
    this.#inline = new Map(this.#snapshot.inlineAttachments().filter((inline2) => notes.has(inline2.noteId)).map((inline2) => [inline2.id, inline2]));
    return this.#inline;
  }
  // Plain text keeps what reads as text: inline tags and mentions.
  text(document) {
    return plainText(document, ({ id: id6 }) => string(this.inline.get(id6)?.altText ?? null) ?? "");
  }
  markdown(document) {
    return markdown(document, ({ id: id6, type }) => {
      const token = this.inline.get(id6);
      if (token !== void 0) {
        const text6 = token.altText ?? "";
        const target = string(token.target);
        return token.type === noteLinkType && target !== null ? `[${text6}](<${target}>)` : text6;
      }
      const attachment = this.attachments.get(id6);
      if (attachment === void 0)
        return "";
      const grid = attachment.table();
      if (grid !== null)
        return `
${markdownTable(grid)}
`;
      const label = string(attachment.title) ?? string(attachment.filename) ?? type ?? id6;
      const url = string(attachment.url);
      return url === null ? `[${label}](attachment:${id6})` : `[${label}](<${url}>)`;
    });
  }
};

// packages/sources/apple/notes/dist/attachments-stream.js
var { id: id2, nullableId, text: text3, nullableText, ordinal: ordinal2, nullableNumber, nullableTimestamp, boolean } = notesFields;
var properties2 = {
  id: {
    ...id2,
    description: "Notes attachment identifier; used by attachment:<id> links in notes.markdown and by attachments.parentId within this source."
  },
  noteId: {
    ...id2,
    description: "Owning note identifier; refers to notes.id within this source. One note can have many attachments."
  },
  parentId: {
    ...nullableId,
    description: "Parent attachment identifier in attachments.id within this source, such as a scan gallery containing pages; NULL for a top-level attachment."
  },
  type: {
    ...text3,
    description: "Uniform type identifier recorded by Notes, such as com.apple.notes.table. public.data is emitted when Notes has no type value."
  },
  title: {
    ...nullableText,
    description: "User-supplied attachment title, or the stored title when none is supplied; NULL when neither is recorded."
  },
  filename: {
    ...nullableText,
    description: "Original media filename recorded by Notes; NULL when the attachment has no media filename. A name alone does not prove the file is available."
  },
  url: {
    ...nullableText,
    description: "URL recorded by Notes for this attachment; NULL when absent or the owning note is locked."
  },
  summary: {
    ...nullableText,
    description: "Summary stored by Notes, not generated by this connector; NULL when absent or the owning note is locked."
  },
  ocrText: {
    ...nullableText,
    description: "OCR summary already stored by Notes; NULL when absent or locked. This is separate from text produced by a destination file parser."
  },
  handwritingText: {
    ...nullableText,
    description: "Handwriting summary stored by Notes; NULL when absent or the owning note is locked."
  },
  imageLabels: {
    ...nullableText,
    description: "Image classification summary stored by Notes; NULL when absent or the owning note is locked."
  },
  transcript: {
    ...nullableText,
    description: "Additional indexable text stored by Notes, including audio transcripts when present; NULL when absent or locked."
  },
  fileSize: {
    ...ordinal2,
    description: "File size recorded by Notes in bytes; 0 is emitted when no numeric size is recorded and does not prove the file is empty."
  },
  duration: {
    ...nullableNumber,
    description: "Duration value recorded by Notes; NULL when absent or zero. The connector passes through the native value without converting units."
  },
  width: {
    ...nullableNumber,
    description: "Width value recorded by Notes; NULL when absent or zero. The connector passes through the native value without converting units."
  },
  height: {
    ...nullableNumber,
    description: "Height value recorded by Notes; NULL when absent or zero. The connector passes through the native value without converting units."
  },
  latitude: {
    type: ["number", "null"],
    minimum: -90,
    maximum: 90,
    description: "Recorded latitude in degrees; NULL when unavailable."
  },
  longitude: {
    type: ["number", "null"],
    minimum: -180,
    maximum: 180,
    description: "Recorded longitude in degrees; NULL when unavailable."
  },
  createdAt: {
    ...nullableTimestamp,
    description: "Attachment creation time recorded by Notes, converted to a UTC instant; NULL when unavailable."
  },
  modifiedAt: {
    ...nullableTimestamp,
    description: "Attachment modification time recorded by Notes, converted to a UTC instant; NULL when unavailable. File download availability can change independently."
  },
  availableLocally: {
    ...boolean,
    description: "Whether the original media file is accessible on this Mac and the owning note is unlocked. False also covers tables and links without a file; it does not imply deletion. Tables are rendered in notes.markdown."
  }
};
var AttachmentsStream = class extends AppleNotesStream {
  name = "attachments";
  jsonSchema = {
    type: "object",
    description: "One source record per attachment of an exported note, including files, links, tables and child scan pages. Metadata can exist without a readable file. Locked notes hide attachment content; undownloaded files remain unavailable until Notes downloads them. Relationships name source streams, not destination tables.",
    properties: properties2,
    required: Object.keys(properties2)
  };
  supportsFileTransfer = true;
  rows(scan) {
    return [...scan.attachments.values()];
  }
  async record(attachment) {
    const content = (value) => attachment.locked ? null : string(value);
    return {
      id: attachment.id,
      noteId: attachment.noteId,
      parentId: string(attachment.parentId),
      type: string(attachment.type) ?? "public.data",
      title: string(attachment.title),
      filename: string(attachment.filename),
      url: content(attachment.url),
      summary: content(attachment.summary),
      ocrText: content(attachment.ocrSummary),
      handwritingText: content(attachment.handwritingSummary),
      imageLabels: content(attachment.imageClassificationSummary),
      transcript: content(attachment.indexableText),
      fileSize: attachment.fileSize ?? 0,
      duration: attachment.duration || null,
      width: attachment.width || null,
      height: attachment.height || null,
      latitude: attachment.latitude,
      longitude: attachment.longitude,
      createdAt: attachment.createdAt?.toISOString() ?? null,
      modifiedAt: attachment.modifiedAt?.toISOString() ?? null,
      availableLocally: await attachment.availableLocally()
    };
  }
  // The original file, not a staged copy: readers only read it.
  file(record, scan) {
    const attachment = scan.attachments.get(record.id);
    return record.availableLocally && attachment !== void 0 ? attachment.file : null;
  }
};

// packages/sources/apple/notes/dist/folders-stream.js
var { id: id3, nullableId: nullableId2, text: text4, ordinal: ordinal3, nullableText: nullableText2, boolean: boolean2 } = notesFields;
var properties3 = {
  id: {
    ...id3,
    description: "Notes folder identifier; referenced by notes.folderId and folders.parentId within this source."
  },
  accountId: {
    ...id3,
    description: "Owning account identifier; refers to accounts.id within this source."
  },
  parentId: {
    ...nullableId2,
    description: "Parent folder identifier in folders.id within this source; NULL for a root folder."
  },
  name: { ...text4, description: "Folder title displayed by Notes." },
  type: {
    ...ordinal3,
    description: "Numeric folder category stored by Notes. 1 means Recently Deleted; its notes remain exported until permanently deleted."
  },
  smartQuery: {
    ...nullableText2,
    description: "Smart-folder query as Notes stores it, encoded as JSON text; NULL when not recorded. It is source metadata, not executable SQL."
  },
  shared: {
    ...boolean2,
    description: "Whether Notes stores sharing metadata for this folder."
  }
};
var FoldersStream = class extends AppleNotesStream {
  name = "folders";
  jsonSchema = {
    type: "object",
    description: "One source record per local Notes folder, including nested folders, smart folders and Recently Deleted, excluding folders marked for deletion. Relationships name streams in this source, not physical destination tables.",
    properties: properties3,
    required: Object.keys(properties3)
  };
  rows(scan) {
    return scan.folders;
  }
  record(folder) {
    return {
      id: folder.id,
      accountId: folder.accountId,
      parentId: string(folder.parentId),
      name: folder.name,
      type: folder.type,
      smartQuery: string(folder.smartQuery),
      shared: folder.shared
    };
  }
};

// packages/sources/apple/notes/dist/inline-attachments-stream.js
var { id: id4, text: text5, nullableText: nullableText3, nullableTimestamp: nullableTimestamp2 } = notesFields;
var properties4 = {
  id: { ...id4, description: "Notes identifier of this inline attachment." },
  noteId: {
    ...id4,
    description: "Containing note identifier; refers to notes.id within this source. One note can contain many inline attachments."
  },
  type: {
    ...text5,
    description: "Notes type identifier, such as com.apple.notes.inlinetextattachment.hashtag; distinguishes tags, mentions, note links and calculation results."
  },
  text: {
    ...nullableText3,
    description: "Text displayed inline, such as #travel; NULL when not recorded."
  },
  target: {
    ...nullableText3,
    description: "Stored target of the inline attachment: for example a normalized tag name such as TRAVEL, or an applenotes:note/<id> URL. Its meaning depends on type; NULL when not recorded."
  },
  createdAt: {
    ...nullableTimestamp2,
    description: "Creation time recorded by Notes, converted to a UTC instant; NULL when unavailable."
  }
};
var InlineAttachmentsStream = class extends AppleNotesStream {
  name = "inlineAttachments";
  jsonSchema = {
    type: "object",
    description: "One source record per inline tag, mention, note link or calculation attachment belonging to an exported note. These are structured references to content also rendered in the note body, not additional notes or file attachments.",
    properties: properties4,
    required: Object.keys(properties4)
  };
  rows(scan) {
    return [...scan.inline.values()];
  }
  record(inline2) {
    return {
      id: inline2.id,
      noteId: inline2.noteId,
      type: inline2.type,
      text: string(inline2.altText),
      target: string(inline2.target),
      createdAt: inline2.createdAt?.toISOString() ?? null
    };
  }
};

// packages/sources/apple/notes/dist/notes-stream.js
var { id: id5, nullableText: nullableText4, nullableTimestamp: nullableTimestamp3, boolean: boolean3 } = notesFields;
var properties5 = {
  id: {
    ...id5,
    description: "Notes note identifier. Attachment noteId fields refer to this identifier within this source."
  },
  accountId: {
    ...id5,
    description: "Owning account identifier; refers to accounts.id within this source."
  },
  folderId: {
    ...id5,
    description: "Containing folder identifier; refers to folders.id within this source. A folder with type 1 is Recently Deleted."
  },
  title: {
    ...nullableText4,
    description: "Note title; NULL when absent. A locked note can still expose its title."
  },
  text: {
    ...nullableText4,
    description: "Visible plain text, including inline tags and mentions, with file placeholders removed. NULL when the note is locked or its body is unavailable."
  },
  markdown: {
    ...nullableText4,
    description: "Note body rendered as Markdown, including checklists and tables. attachment:<id> links refer to attachments.id within this source; applenotes: links refer to other notes. NULL when locked or the body is unavailable. Fonts, colors and underline are not represented."
  },
  createdAt: {
    ...nullableTimestamp3,
    description: "Creation time recorded by Notes, converted to a UTC instant; NULL when unavailable."
  },
  modifiedAt: {
    ...nullableTimestamp3,
    description: "Modification time recorded by Notes, converted to a UTC instant; NULL when unavailable. This is not the time of extraction or proof that all changes advanced this timestamp."
  },
  pinned: {
    ...boolean3,
    description: "Whether Notes marks this note as pinned."
  },
  hasChecklist: {
    ...boolean3,
    description: "Notes reports that the note contains a checklist. This flag can be available even when a locked body cannot be read."
  },
  checklistInProgress: {
    ...boolean3,
    description: "Notes reports that a checklist is in progress; this is its stored flag, not a count of unfinished items."
  },
  locked: {
    ...boolean3,
    description: "Whether Notes marks the note as password protected. The connector does not decrypt it; text and markdown remain NULL."
  },
  shared: {
    ...boolean3,
    description: "Whether Notes stores sharing metadata for this note."
  }
};
var NotesStream = class extends AppleNotesStream {
  name = "notes";
  jsonSchema = {
    type: "object",
    description: "One source record per note currently in the local Notes store with an account and folder. Includes locked notes and Recently Deleted; excludes cloud placeholders without a folder and records marked for deletion. Only Notes syncs remote changes to this Mac.",
    properties: properties5,
    required: Object.keys(properties5)
  };
  rows(scan) {
    return scan.notes;
  }
  // A locked note has no document: it keeps its title, dates and flags.
  record(note, scan) {
    const document = note.document();
    return {
      id: note.id,
      accountId: note.accountId,
      folderId: note.folderId,
      title: string(note.title),
      text: document === null ? null : scan.text(document),
      markdown: document === null ? null : scan.markdown(document),
      createdAt: note.createdAt?.toISOString() ?? null,
      modifiedAt: note.modifiedAt?.toISOString() ?? null,
      pinned: note.pinned,
      hasChecklist: note.hasChecklist,
      checklistInProgress: note.checklistInProgress,
      locked: note.locked,
      shared: note.shared
    };
  }
};

// packages/sources/apple/notes/dist/apple-notes-source.js
var readers = {
  accounts: new AccountsStream(),
  folders: new FoldersStream(),
  notes: new NotesStream(),
  inlineAttachments: new InlineAttachmentsStream(),
  attachments: new AttachmentsStream()
};
var catalog = new Catalog(Object.values(readers).map((reader) => reader.describe()));
var readersByName = new Map(Object.values(readers).map((reader) => [reader.name, reader]));
var pollIntervalMs = 1e3;
var launchIntervalMs = 3e4;
var AppleNotesSource = class extends Source {
  identity;
  catalog = catalog;
  accounts = readers.accounts.describe();
  folders = readers.folders.describe();
  notes = readers.notes.describe();
  inlineAttachments = readers.inlineAttachments.describe();
  attachments = readers.attachments.describe();
  path;
  scope;
  #store;
  constructor({ path = noteStorePath, scope = {} } = {}) {
    super();
    this.path = path;
    this.scope = scope;
    this.#store = new NotesStore(path);
    this.identity = `apple-notes:${path}`;
    Object.freeze(this);
  }
  async open() {
    return new NotesScan(this.#store.open(), this.scope);
  }
  coverage(_stream) {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }
  async *observe({ streams, signal }) {
    var _stack = [];
    try {
      if (signal.aborted)
        return;
      const version = __using(_stack, this.#store.version());
      let seen = version.current;
      await launchNotesHidden();
      let nextLaunch = Date.now() + launchIntervalMs;
      yield streams;
      try {
        for await (const _2 of setInterval(pollIntervalMs, void 0, {
          signal
        })) {
          if (Date.now() >= nextLaunch) {
            await launchNotesHidden();
            nextLaunch = Date.now() + launchIntervalMs;
          }
          const current = version.current;
          if (current === seen)
            continue;
          seen = current;
          yield streams;
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError"))
          throw error;
      }
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  async *extract(configuration, state, _partition, scan) {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === void 0)
      throw new Error(`Apple Notes has no stream ${stream.name}`);
    const records = await reader.read(scan);
    const messages = configuration.syncMode === "incremental" ? diffSnapshot(stream, records, state) : records.map((data) => ({ stream: stream.name, data }));
    for await (const message of messages) {
      if ("type" in message || configuration.fileReads.length === 0)
        yield message;
      else
        yield {
          ...message,
          file: reader.file(message.data, scan)
        };
    }
  }
};

// packages/connectors/apple/notes/dist/notes-connector.js
var NotesConnector = class extends AppleConnector {
  datedBy = "date last edited";
  fullDiskAccess = true;
  note = "Exact containing folders; select descendants separately. Smart folders are saved searches and cannot be selected as containing folders.";
  choices = [
    accounts(name),
    collections("folders", "folders")
  ];
  unscoped = [];
  storeCopies = [];
  access() {
    return "Open Notes to let it finish syncing iCloud changes.";
  }
  source(scope) {
    return new AppleNotesSource({ scope });
  }
};
export {
  NotesConnector as default
};
