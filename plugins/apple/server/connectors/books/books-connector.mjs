import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  ProtobufMessage
} from "../../chunks/chunk-QMS7KGTZ.mjs";
import {
  isBinaryPlist,
  isDictionary,
  parseBinaryPlist
} from "../../chunks/chunk-GXPN73JS.mjs";
import {
  localAppleStoreCoverage
} from "../../chunks/chunk-BRJ4TKR5.mjs";
import {
  AppDatabase,
  AppDatabaseVersion
} from "../../chunks/chunk-SDFTRGL6.mjs";
import {
  AppleConnector
} from "../../chunks/chunk-PGV23ONC.mjs";
import {
  Catalog,
  Source,
  Stream,
  diffSnapshot,
  validateRecords
} from "../../chunks/chunk-OC6XOTPF.mjs";
import {
  __callDispose,
  __using
} from "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/sources/apple/books/dist/apple-books-source.js
import { mkdtempDisposable, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join4 } from "node:path";
import { setInterval } from "node:timers/promises";

// packages/sdks/apple/books/dist/books-values.js
var appleEpochSeconds = 978307200;
var distantPast = -63114076800;
var distantFuture = 63113904e3;
var coreDataTime = (value) => typeof value === "number" && Number.isFinite(value) && value > distantPast && value < distantFuture ? new Date(Math.round((value + appleEpochSeconds) * 1e3)) : null;
var plistTime = (value) => value instanceof Date && value.getUTCFullYear() > 1 && value.getUTCFullYear() < 4001 ? value : null;
var text = (value) => typeof value === "string" && value !== "" ? value : null;
var stored = (value) => typeof value === "string" ? value : null;
var integer = (value) => typeof value === "number" && Number.isSafeInteger(value) ? value : null;
var number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
var flag = (value) => value === 1 || value === true;
var nullableFlag = (value) => value === null || value === void 0 ? null : value === 1;
var bytes = (value) => value instanceof Uint8Array && value.length > 0 ? value : null;
var dictionary = (value) => isDictionary(value) ? value : {};

// packages/sdks/apple/books/dist/errors.js
var BooksUnavailableError = class extends Error {
  name = "BooksUnavailableError";
  constructor(path, cause) {
    super(`Books data at ${path} cannot be read. Open Books once so it creates its stores; if they exist, allow the process that runs the export Full Disk Access in System Settings > Privacy & Security. Books does not need to be open.`, { cause });
  }
};
var BooksSchemaError = class extends Error {
  name = "BooksSchemaError";
  constructor(path, missing) {
    super(`The Books store at ${path} has a layout this reader does not read (missing ${missing.join(", ")}).`);
  }
};

// packages/sdks/apple/books/dist/book-asset-data.js
var assetDataColumns = {
  ZBCASSETDETAIL: [
    "ZASSETID",
    "ZDELETEDFLAG",
    "ZREADINGPROGRESS",
    "ZREADINGPROGRESSHIGHWATERMARK",
    "ZISFINISHED",
    "ZNOTFINISHED",
    "ZFINISHEDDATEKIND",
    "ZDATEFINISHED",
    "ZISTRACKEDASRECENT",
    "ZLASTOPENDATE",
    "ZLASTENGAGEDDATE",
    "ZMODIFICATIONDATE",
    "ZSTARRATING",
    "ZTASTE",
    "ZTASTESYNCEDTOSTORE",
    "ZBOOKMARKTIME",
    "ZDATEPLAYBACKTIMEUPDATED",
    "ZREADINGPOSITIONCFISTRING",
    "ZREADINGPOSITIONLOCATIONRANGESTART",
    "ZREADINGPOSITIONLOCATIONRANGEEND",
    "ZREADINGPOSITIONABSOLUTEPHYSICALLOCATION",
    "ZREADINGPOSITIONSTORAGEUUID",
    "ZREADINGPOSITIONASSETVERSION",
    "ZREADINGPOSITIONANNOTATIONVERSION",
    "ZREADINGPOSITIONLOCATIONUPDATEDATE"
  ],
  ZBCASSETREVIEW: [
    "ZASSETREVIEWID",
    "ZDELETEDFLAG",
    "ZSTARRATING",
    "ZREVIEWTITLE",
    "ZREVIEWBODY",
    "ZUSERID",
    "ZMODIFICATIONDATE"
  ]
};
var BookAssetData = class {
  #database;
  constructor(path) {
    this.#database = new AppDatabase(path, BooksUnavailableError);
    this.#database.requireColumns(assetDataColumns, BooksSchemaError);
  }
  details() {
    return this.#database.all("SELECT * FROM ZBCASSETDETAIL WHERE ZASSETID IS NOT NULL ORDER BY Z_PK").map((row) => ({
      assetId: stored(row.ZASSETID),
      deleted: flag(row.ZDELETEDFLAG),
      readingProgress: number(row.ZREADINGPROGRESS),
      highWaterMarkProgress: number(row.ZREADINGPROGRESSHIGHWATERMARK),
      isFinished: flag(row.ZISFINISHED),
      notFinished: nullableFlag(row.ZNOTFINISHED),
      finishedDateKind: integer(row.ZFINISHEDDATEKIND),
      finishedAt: coreDataTime(row.ZDATEFINISHED),
      isTrackedAsRecent: nullableFlag(row.ZISTRACKEDASRECENT),
      lastOpenedAt: coreDataTime(row.ZLASTOPENDATE),
      lastEngagedAt: coreDataTime(row.ZLASTENGAGEDDATE),
      modifiedAt: coreDataTime(row.ZMODIFICATIONDATE),
      starRating: integer(row.ZSTARRATING),
      taste: integer(row.ZTASTE),
      tasteSyncedToStore: nullableFlag(row.ZTASTESYNCEDTOSTORE),
      audiobookPosition: number(row.ZBOOKMARKTIME),
      audiobookPositionUpdatedAt: coreDataTime(row.ZDATEPLAYBACKTIMEUPDATED),
      position: text(row.ZREADINGPOSITIONCFISTRING),
      positionRangeStart: integer(row.ZREADINGPOSITIONLOCATIONRANGESTART),
      positionRangeEnd: integer(row.ZREADINGPOSITIONLOCATIONRANGEEND),
      positionPhysicalLocation: integer(row.ZREADINGPOSITIONABSOLUTEPHYSICALLOCATION),
      positionStorageId: text(row.ZREADINGPOSITIONSTORAGEUUID),
      positionAssetVersion: text(row.ZREADINGPOSITIONASSETVERSION),
      positionAnnotationVersion: text(row.ZREADINGPOSITIONANNOTATIONVERSION),
      positionUpdatedAt: coreDataTime(row.ZREADINGPOSITIONLOCATIONUPDATEDATE)
    }));
  }
  reviews() {
    return this.#database.all("SELECT * FROM ZBCASSETREVIEW WHERE ZASSETREVIEWID IS NOT NULL ORDER BY Z_PK").map((row) => ({
      id: stored(row.ZASSETREVIEWID),
      deleted: flag(row.ZDELETEDFLAG),
      starRating: integer(row.ZSTARRATING),
      title: text(row.ZREVIEWTITLE),
      body: text(row.ZREVIEWBODY),
      userId: text(row.ZUSERID),
      modifiedAt: coreDataTime(row.ZMODIFICATIONDATE)
    }));
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
};

// packages/sdks/apple/books/dist/epub-package.js
import { open } from "node:fs/promises";
import { crc32 } from "node:zlib";

// packages/sdks/apple/books/dist/icloud-files.js
import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
var run = promisify(execFile);
var dataless = 1073741824;
async function flags(paths) {
  const found = /* @__PURE__ */ new Map();
  for (let start = 0; start < paths.length; start += 256) {
    const batch = paths.slice(start, start + 256);
    const { stdout } = await run("/usr/bin/stat", ["-f", "%Xf %N", ...batch], {
      maxBuffer: 16 * 1024 * 1024
    }).catch((error) => {
      if (typeof error.stdout === "string")
        return { stdout: error.stdout };
      throw error;
    });
    for (const line of stdout.split("\n")) {
      const space = line.indexOf(" ");
      if (space > 0)
        found.set(line.slice(space + 1), Number.parseInt(line.slice(0, space), 16));
    }
  }
  return found;
}
async function localPaths(paths) {
  const found = await flags(paths);
  return new Set(paths.filter((path) => {
    const value = found.get(path);
    return value !== void 0 && (value & dataless) === 0;
  }));
}
function compareByName(a, b) {
  if (a.name < b.name)
    return -1;
  if (a.name > b.name)
    return 1;
  return 0;
}
async function localFiles(item) {
  if (!(await localPaths([item])).has(item))
    return null;
  const info = await lstat(item);
  if (info.isFile())
    return [
      {
        name: "",
        path: item,
        size: info.size,
        modifiedMs: info.mtimeMs
      }
    ];
  if (!info.isDirectory())
    return null;
  const files = [];
  const pending = [""];
  for (let relative = pending.pop(); relative !== void 0; relative = pending.pop()) {
    const directory = join(item, relative);
    const entries = await readdir(directory, { withFileTypes: true });
    const listed = entries.map((entry) => ({
      entry,
      path: join(directory, entry.name)
    }));
    const local = await localPaths(listed.map(({ path }) => path));
    for (const { entry, path } of listed) {
      if (!local.has(path))
        return null;
      const name = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory())
        pending.push(name);
      else if (entry.isFile()) {
        const { size, mtimeMs } = await lstat(path);
        files.push({ name, path, size, modifiedMs: mtimeMs });
      }
    }
  }
  return files.sort(compareByName);
}

// packages/sdks/apple/books/dist/epub-package.js
var chunkSize = 4 * 1024 * 1024;
var dosTime = 0;
var dosDate = 0 << 9 | 1 << 5 | 1;
var utf8Names = 2048;
async function checksum(path) {
  var _stack = [];
  try {
    const file = __using(_stack, await open(path), true);
    let value = 0;
    const buffer = Buffer.allocUnsafe(chunkSize);
    for (; ; ) {
      const { bytesRead } = await file.read(buffer, 0, chunkSize, null);
      if (bytesRead === 0)
        return value;
      value = crc32(buffer.subarray(0, bytesRead), value);
    }
  } catch (_) {
    var _error = _, _hasError = true;
  } finally {
    var _promise = __callDispose(_stack, _error, _hasError);
    _promise && await _promise;
  }
}
function localHeader({ name, file, crc }) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(67324752, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(utf8Names, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(dosTime, 10);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(file.size, 18);
  header.writeUInt32LE(file.size, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, name]);
}
function centralHeader({ name, file, crc }, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(33639248, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(utf8Names, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(dosTime, 12);
  header.writeUInt16LE(dosDate, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(file.size, 20);
  header.writeUInt32LE(file.size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, name]);
}
async function writeEpub(files, target) {
  var _stack2 = [];
  try {
    const mimetype = files.find((file) => file.name === "mimetype");
    if (mimetype === void 0)
      throw new TypeError("EPUB package has no mimetype file");
    const ordered = [
      mimetype,
      ...files.filter((file) => file !== mimetype).sort(compareByName)
    ];
    if (ordered.length > 65535)
      throw new RangeError("EPUB package has too many files for a ZIP");
    const entries = [];
    for (const file of ordered)
      entries.push({
        name: Buffer.from(file.name, "utf8"),
        file,
        crc: await checksum(file.path)
      });
    const output = __using(_stack2, await open(target, "wx", 384), true);
    let offset = 0;
    const write = async (bytes2) => {
      await output.write(bytes2);
      offset += bytes2.length;
    };
    const written = [];
    const buffer = Buffer.allocUnsafe(chunkSize);
    for (const entry of entries) {
      var _stack = [];
      try {
        written.push({ entry, offset });
        await write(localHeader(entry));
        const input = __using(_stack, await open(entry.file.path), true);
        let remaining = entry.file.size;
        while (remaining > 0) {
          const { bytesRead } = await input.read(buffer, 0, Math.min(chunkSize, remaining), null);
          if (bytesRead === 0)
            throw new Error(`${entry.file.path} shrank while it was packaged`);
          await write(buffer.subarray(0, bytesRead));
          remaining -= bytesRead;
        }
        if (offset > 4294967295)
          throw new RangeError("EPUB package exceeds 4 GiB without ZIP64");
      } catch (_) {
        var _error = _, _hasError = true;
      } finally {
        var _promise = __callDispose(_stack, _error, _hasError);
        _promise && await _promise;
      }
    }
    const directoryStart = offset;
    for (const { entry, offset: start } of written)
      await write(centralHeader(entry, start));
    const end = Buffer.alloc(22);
    end.writeUInt32LE(101010256, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - directoryStart, 12);
    end.writeUInt32LE(directoryStart, 16);
    await write(end);
    await output.sync();
  } catch (_2) {
    var _error2 = _2, _hasError2 = true;
  } finally {
    var _promise2 = __callDispose(_stack2, _error2, _hasError2);
    _promise2 && await _promise2;
  }
}

// packages/sdks/apple/books/dist/book-files.js
var bookFileFormats = ["epub-package", "file"];
var single = (files) => files.length === 1 && files[0]?.name === "";
function exportable(path, files) {
  if (files === null || single(files))
    return files;
  return path.toLowerCase().endsWith(".epub") ? files : null;
}
async function bookFile(assetId, path) {
  const listed = await localFiles(path).catch((error) => {
    if (error.code === "ENOENT")
      return null;
    throw error;
  });
  const files = exportable(path, listed);
  return {
    assetId,
    path,
    format: listed === null ? path.toLowerCase().endsWith(".epub") ? "epub-package" : "file" : single(listed) ? "file" : "epub-package",
    availableLocally: files !== null,
    fileCount: files?.length ?? null,
    sizeBytes: files?.reduce((sum, file) => sum + file.size, 0) ?? null,
    modifiedAt: files === null || files.length === 0 ? null : new Date(Math.max(...files.map((file) => file.modifiedMs)))
  };
}
async function exportBookFile(path, epubTarget) {
  const files = exportable(path, await localFiles(path));
  if (files === null)
    return null;
  if (single(files))
    return files[0]?.path ?? null;
  await writeEpub(files, epubTarget);
  return epubTarget;
}

// packages/sdks/apple/books/dist/books-annotations.js
var annotationsColumns = {
  ZAEANNOTATION: [
    "ZANNOTATIONUUID",
    "ZANNOTATIONASSETID",
    "ZANNOTATIONTYPE",
    "ZANNOTATIONSTYLE",
    "ZANNOTATIONISUNDERLINE",
    "ZANNOTATIONDELETED",
    "ZANNOTATIONSELECTEDTEXT",
    "ZANNOTATIONREPRESENTATIVETEXT",
    "ZANNOTATIONNOTE",
    "ZANNOTATIONLOCATION",
    "ZPLLOCATIONRANGESTART",
    "ZPLLOCATIONRANGEEND",
    "ZPLABSOLUTEPHYSICALLOCATION",
    "ZPLSTORAGEUUID",
    "ZANNOTATIONCREATORIDENTIFIER",
    "ZANNOTATIONCREATIONDATE",
    "ZANNOTATIONMODIFICATIONDATE",
    "ZFUTUREPROOFING5"
  ]
};
var annotationKinds = ["highlight", "readingPosition"];
var annotationKindsByCode = /* @__PURE__ */ new Map([
  [2, "highlight"],
  [3, "readingPosition"]
]);
var BooksAnnotations = class {
  #database;
  constructor(path) {
    this.#database = new AppDatabase(path, BooksUnavailableError);
    this.#database.requireColumns(annotationsColumns, BooksSchemaError);
  }
  annotations() {
    return this.#database.all("SELECT * FROM ZAEANNOTATION WHERE ZANNOTATIONUUID IS NOT NULL ORDER BY Z_PK").map((row) => {
      const kindCode = integer(row.ZANNOTATIONTYPE);
      return {
        id: stored(row.ZANNOTATIONUUID),
        assetId: text(row.ZANNOTATIONASSETID),
        kind: kindCode === null ? null : annotationKindsByCode.get(kindCode) ?? null,
        kindCode,
        style: integer(row.ZANNOTATIONSTYLE),
        underline: flag(row.ZANNOTATIONISUNDERLINE),
        deleted: flag(row.ZANNOTATIONDELETED),
        selectedText: text(row.ZANNOTATIONSELECTEDTEXT),
        representativeText: text(row.ZANNOTATIONREPRESENTATIVETEXT),
        note: text(row.ZANNOTATIONNOTE),
        chapter: text(row.ZFUTUREPROOFING5),
        location: text(row.ZANNOTATIONLOCATION),
        rangeStart: integer(row.ZPLLOCATIONRANGESTART),
        rangeEnd: integer(row.ZPLLOCATIONRANGEEND),
        physicalLocation: integer(row.ZPLABSOLUTEPHYSICALLOCATION),
        storageId: text(row.ZPLSTORAGEUUID),
        creator: text(row.ZANNOTATIONCREATORIDENTIFIER),
        createdAt: coreDataTime(row.ZANNOTATIONCREATIONDATE),
        modifiedAt: coreDataTime(row.ZANNOTATIONMODIFICATIONDATE)
      };
    });
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
};

// packages/sdks/apple/books/dist/books-library.js
var libraryColumns = {
  ZBKLIBRARYASSET: [
    "Z_PK",
    "ZASSETID",
    "ZTITLE",
    "ZSORTTITLE",
    "ZAUTHOR",
    "ZSORTAUTHOR",
    "ZAUTHORCOUNT",
    "ZAUTHORNAMES",
    "ZNARRATORCOUNT",
    "ZNARRATORNAMES",
    "ZGENRE",
    "ZGENRES",
    "ZLANGUAGE",
    "ZBOOKDESCRIPTION",
    "ZCOMMENTS",
    "ZGROUPING",
    "ZYEAR",
    "ZKIND",
    "ZCONTENTTYPE",
    "ZMAPPEDASSETCONTENTTYPE",
    "ZMAPPEDASSETID",
    "ZTEMPORARYASSETID",
    "ZEPUBID",
    "ZASSETGUID",
    "ZSTOREID",
    "ZSTOREPLAYLISTID",
    "ZFAMILYID",
    "ZACCOUNTID",
    "ZPURCHASEDDSID",
    "ZDOWNLOADEDDSID",
    "ZDATASOURCEIDENTIFIER",
    "ZPATH",
    "ZURL",
    "ZPERMLINK",
    "ZCOVERURL",
    "ZCOVERASPECTRATIO",
    "ZCOVERWRITINGMODE",
    "ZPAGEPROGRESSIONDIRECTION",
    "ZPAGECOUNT",
    "ZFILESIZE",
    "ZDURATION",
    "ZREADINGPROGRESS",
    "ZBOOKHIGHWATERMARKPROGRESS",
    "ZISFINISHED",
    "ZNOTFINISHED",
    "ZFINISHEDDATEKIND",
    "ZDATEFINISHED",
    "ZLASTOPENDATE",
    "ZLASTENGAGEDDATE",
    "ZCREATIONDATE",
    "ZMODIFICATIONDATE",
    "ZPURCHASEDATE",
    "ZRELEASEDATE",
    "ZUPDATEDATE",
    "ZEXPECTEDDATE",
    "ZRATING",
    "ZCOMPUTEDRATING",
    "ZTASTE",
    "ZTASTESYNCEDTOSTORE",
    "ZISSAMPLE",
    "ZISEXPLICIT",
    "ZISHIDDEN",
    "ZISLOCKED",
    "ZISNEW",
    "ZISPROOF",
    "ZISDEVELOPMENT",
    "ZISEPHEMERAL",
    "ZISSTOREAUDIOBOOK",
    "ZISSUPPLEMENTALCONTENT",
    "ZISTRACKEDASRECENT",
    "ZCANREDOWNLOAD",
    "ZHASRACSUPPORT",
    "ZDESKTOPSUPPORTLEVEL",
    "ZSTATE",
    "ZCOMBINEDSTATE",
    "ZVERSIONNUMBER",
    "ZVERSIONNUMBERHUMANREADABLE",
    "ZSERIESID",
    "ZSERIESCONTAINER",
    "ZSEQUENCENUMBER",
    "ZSEQUENCEDISPLAYNAME",
    "ZSERIESISORDERED",
    "ZSERIESISHIDDEN",
    "ZSERIESISCLOUDONLY",
    "ZSUPPLEMENTALCONTENTPARENT"
  ],
  ZBKCOLLECTION: [
    "Z_PK",
    "ZCOLLECTIONID",
    "ZTITLE",
    "ZDETAILS",
    "ZDELETEDFLAG",
    "ZHIDDEN",
    "ZPLACEHOLDER",
    "ZSORTKEY",
    "ZSORTMODE",
    "ZVIEWMODE",
    "ZLASTMODIFICATION",
    "ZLOCALMODDATE"
  ],
  ZBKCOLLECTIONMEMBER: ["ZCOLLECTION", "ZASSETID", "ZSORTKEY", "ZLOCALMODDATE"]
};
var assetsQuery = `
      SELECT asset.*,
        container.ZASSETID AS seriesContainerAssetId,
        parent.ZASSETID AS supplementalContentParentAssetId
      FROM ZBKLIBRARYASSET asset
      LEFT JOIN ZBKLIBRARYASSET container ON container.Z_PK = asset.ZSERIESCONTAINER
      LEFT JOIN ZBKLIBRARYASSET parent ON parent.Z_PK = asset.ZSUPPLEMENTALCONTENTPARENT
      WHERE asset.ZASSETID IS NOT NULL
      ORDER BY asset.Z_PK`;
var collectionMembersQuery = `
      SELECT collection.ZCOLLECTIONID AS collectionId, member.ZASSETID,
        member.ZSORTKEY, member.ZLOCALMODDATE
      FROM ZBKCOLLECTIONMEMBER member
      JOIN ZBKCOLLECTION collection ON collection.Z_PK = member.ZCOLLECTION
      WHERE collection.ZCOLLECTIONID IS NOT NULL AND member.ZASSETID IS NOT NULL
      ORDER BY member.Z_PK`;
var contentTypes = ["epub", "pdf"];
var contentTypesByCode = /* @__PURE__ */ new Map([
  [1, "epub"],
  [3, "pdf"]
]);
var libraryAsset = (row) => {
  const contentTypeCode = integer(row.ZCONTENTTYPE);
  return {
    assetId: stored(row.ZASSETID),
    title: text(row.ZTITLE),
    sortTitle: text(row.ZSORTTITLE),
    author: text(row.ZAUTHOR),
    sortAuthor: text(row.ZSORTAUTHOR),
    authorCount: integer(row.ZAUTHORCOUNT),
    authorNames: bytes(row.ZAUTHORNAMES),
    narratorCount: integer(row.ZNARRATORCOUNT),
    narratorNames: bytes(row.ZNARRATORNAMES),
    genre: text(row.ZGENRE),
    genres: bytes(row.ZGENRES),
    language: text(row.ZLANGUAGE),
    bookDescription: text(row.ZBOOKDESCRIPTION),
    comments: text(row.ZCOMMENTS),
    grouping: text(row.ZGROUPING),
    year: text(row.ZYEAR),
    kind: text(row.ZKIND),
    contentType: contentTypeCode === null ? null : contentTypesByCode.get(contentTypeCode) ?? null,
    contentTypeCode,
    mappedAssetId: text(row.ZMAPPEDASSETID),
    mappedAssetContentTypeCode: integer(row.ZMAPPEDASSETCONTENTTYPE),
    temporaryAssetId: text(row.ZTEMPORARYASSETID),
    epubId: text(row.ZEPUBID),
    assetGuid: text(row.ZASSETGUID),
    storeId: text(row.ZSTOREID),
    storePlaylistId: text(row.ZSTOREPLAYLISTID),
    familyId: text(row.ZFAMILYID),
    accountId: text(row.ZACCOUNTID),
    purchasedDsid: text(row.ZPURCHASEDDSID),
    downloadedDsid: text(row.ZDOWNLOADEDDSID),
    dataSource: text(row.ZDATASOURCEIDENTIFIER),
    path: text(row.ZPATH),
    url: text(row.ZURL),
    permalink: text(row.ZPERMLINK),
    coverUrl: text(row.ZCOVERURL),
    coverAspectRatio: number(row.ZCOVERASPECTRATIO),
    coverWritingMode: text(row.ZCOVERWRITINGMODE),
    pageProgressionDirection: text(row.ZPAGEPROGRESSIONDIRECTION),
    pageCount: integer(row.ZPAGECOUNT),
    fileSize: integer(row.ZFILESIZE),
    duration: number(row.ZDURATION),
    readingProgress: number(row.ZREADINGPROGRESS),
    highWaterMarkProgress: number(row.ZBOOKHIGHWATERMARKPROGRESS),
    isFinished: flag(row.ZISFINISHED),
    notFinished: nullableFlag(row.ZNOTFINISHED),
    finishedDateKind: integer(row.ZFINISHEDDATEKIND),
    finishedAt: coreDataTime(row.ZDATEFINISHED),
    lastOpenedAt: coreDataTime(row.ZLASTOPENDATE),
    lastEngagedAt: coreDataTime(row.ZLASTENGAGEDDATE),
    createdAt: coreDataTime(row.ZCREATIONDATE),
    modifiedAt: coreDataTime(row.ZMODIFICATIONDATE),
    purchasedAt: coreDataTime(row.ZPURCHASEDATE),
    releasedAt: coreDataTime(row.ZRELEASEDATE),
    updatedAt: coreDataTime(row.ZUPDATEDATE),
    expectedAt: coreDataTime(row.ZEXPECTEDDATE),
    rating: integer(row.ZRATING),
    computedRating: integer(row.ZCOMPUTEDRATING),
    taste: integer(row.ZTASTE),
    tasteSyncedToStore: nullableFlag(row.ZTASTESYNCEDTOSTORE),
    isSample: flag(row.ZISSAMPLE),
    isExplicit: nullableFlag(row.ZISEXPLICIT),
    isHidden: flag(row.ZISHIDDEN),
    isLocked: nullableFlag(row.ZISLOCKED),
    isNew: nullableFlag(row.ZISNEW),
    isProof: nullableFlag(row.ZISPROOF),
    isDevelopment: nullableFlag(row.ZISDEVELOPMENT),
    isEphemeral: nullableFlag(row.ZISEPHEMERAL),
    isStoreAudiobook: nullableFlag(row.ZISSTOREAUDIOBOOK),
    isSupplementalContent: nullableFlag(row.ZISSUPPLEMENTALCONTENT),
    supplementalContentParentAssetId: text(row.supplementalContentParentAssetId),
    isTrackedAsRecent: nullableFlag(row.ZISTRACKEDASRECENT),
    canRedownload: nullableFlag(row.ZCANREDOWNLOAD),
    hasReadAloudSupport: nullableFlag(row.ZHASRACSUPPORT),
    desktopSupportLevel: integer(row.ZDESKTOPSUPPORTLEVEL),
    state: integer(row.ZSTATE),
    combinedState: integer(row.ZCOMBINEDSTATE),
    versionNumber: number(row.ZVERSIONNUMBER),
    version: text(row.ZVERSIONNUMBERHUMANREADABLE),
    seriesId: text(row.ZSERIESID),
    seriesContainerAssetId: text(row.seriesContainerAssetId),
    sequenceNumber: number(row.ZSEQUENCENUMBER),
    sequenceDisplayName: text(row.ZSEQUENCEDISPLAYNAME),
    seriesIsOrdered: nullableFlag(row.ZSERIESISORDERED),
    seriesIsHidden: nullableFlag(row.ZSERIESISHIDDEN),
    seriesIsCloudOnly: nullableFlag(row.ZSERIESISCLOUDONLY)
  };
};
var BooksLibrary = class {
  #database;
  constructor(path) {
    this.#database = new AppDatabase(path, BooksUnavailableError);
    this.#database.requireColumns(libraryColumns, BooksSchemaError);
  }
  assets() {
    return this.#database.all(assetsQuery).map(libraryAsset);
  }
  collections() {
    return this.#database.all("SELECT * FROM ZBKCOLLECTION WHERE ZCOLLECTIONID IS NOT NULL ORDER BY Z_PK").map((row) => ({
      collectionId: stored(row.ZCOLLECTIONID),
      title: text(row.ZTITLE),
      details: text(row.ZDETAILS),
      deleted: flag(row.ZDELETEDFLAG),
      hidden: flag(row.ZHIDDEN),
      placeholder: flag(row.ZPLACEHOLDER),
      sortKey: integer(row.ZSORTKEY),
      sortMode: integer(row.ZSORTMODE),
      viewMode: integer(row.ZVIEWMODE),
      modifiedAt: coreDataTime(row.ZLASTMODIFICATION),
      localModifiedAt: coreDataTime(row.ZLOCALMODDATE)
    }));
  }
  collectionMembers() {
    return this.#database.all(collectionMembersQuery).map((row) => ({
      collectionId: stored(row.collectionId),
      assetId: stored(row.ZASSETID),
      sortKey: integer(row.ZSORTKEY),
      addedAt: coreDataTime(row.ZLOCALMODDATE)
    }));
  }
  // Each asset's file or package and what of it is on this Mac, read from
  // iCloud's file flags so no placeholder is downloaded.
  async bookFiles() {
    const files = [];
    for (const row of this.#database.all("SELECT ZASSETID, ZPATH FROM ZBKLIBRARYASSET WHERE ZASSETID IS NOT NULL AND ZPATH IS NOT NULL ORDER BY Z_PK"))
      files.push(await bookFile(String(row.ZASSETID), String(row.ZPATH)));
    return files;
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
};

// packages/sdks/apple/books/dist/books-location.js
import { homedir } from "node:os";
import { join as join2 } from "node:path";
var booksContainer = join2(homedir(), "Library/Containers/com.apple.iBooksX/Data");
var booksGroupContainer = join2(homedir(), "Library/Group Containers/group.com.apple.iBooks");
var bookData = (group) => join2(group, "Documents/BCCloudData-BookDataStoreService");
var storeFiles = ({ container, groupContainer }) => ({
  library: join2(container, "Documents/BKLibrary/BKLibrary-1-091020131601.sqlite"),
  annotations: join2(container, "Documents/AEAnnotation/AEAnnotation_v10312011_1727_local.sqlite"),
  assetData: join2(bookData(groupContainer), "BCAssetData/BCAssetData"),
  readingHistory: join2(bookData(groupContainer), "CRDTModelSync-ReadingHistoryModel/CRDTModelSync-ReadingHistoryModel"),
  purchases: join2(groupContainer, "Documents/BKJaliscoServerSource/BKJaliscoServerSource-v09182016.sqlite"),
  themes: join2(container, "Library/Application Support/Books/BookTheme.sqlite"),
  preferences: join2(container, "Library/Preferences/com.apple.iBooksX.plist")
});
var sharedPreferences = ({ groupContainer }) => join2(groupContainer, "Library/Preferences/group.com.apple.iBooks.plist");

// packages/sdks/apple/books/dist/books-purchases.js
var purchasesColumns = {
  ZBLJALISCOSERVERITEM: [
    "ZSTOREID",
    "ZTITLE",
    "ZSORTEDTITLE",
    "ZARTIST",
    "ZSORTEDAUTHOR",
    "ZGENRE",
    "ZFILEEXTENSION",
    "ZDISPLAYVERSION",
    "ZPURCHASEDAT",
    "ZEXPECTEDDATE",
    "ZISAUDIOBOOK",
    "ZCONTAINSAUDIO",
    "ZISEXPLICIT",
    "ZISHIDDEN",
    "ZISDISABLED",
    "ZISPICTUREBOOK",
    "ZISREADALOUD",
    "ZPURCHASEHISTORYID",
    "ZSTOREACCOUNTID",
    "ZARTWORKURLSTRING"
  ]
};
var BooksPurchases = class {
  #database;
  constructor(path) {
    this.#database = new AppDatabase(path, BooksUnavailableError);
    this.#database.requireColumns(purchasesColumns, BooksSchemaError);
  }
  purchases() {
    return this.#database.all("SELECT * FROM ZBLJALISCOSERVERITEM WHERE ZSTOREID IS NOT NULL ORDER BY Z_PK").map((row) => ({
      storeId: String(row.ZSTOREID),
      title: text(row.ZTITLE),
      sortTitle: text(row.ZSORTEDTITLE),
      artist: text(row.ZARTIST),
      sortAuthor: text(row.ZSORTEDAUTHOR),
      genre: text(row.ZGENRE),
      fileExtension: text(row.ZFILEEXTENSION),
      version: text(row.ZDISPLAYVERSION),
      purchasedAt: coreDataTime(row.ZPURCHASEDAT),
      expectedAt: coreDataTime(row.ZEXPECTEDDATE),
      isAudiobook: nullableFlag(row.ZISAUDIOBOOK),
      containsAudio: nullableFlag(row.ZCONTAINSAUDIO),
      isExplicit: nullableFlag(row.ZISEXPLICIT),
      isHidden: nullableFlag(row.ZISHIDDEN),
      isDisabled: nullableFlag(row.ZISDISABLED),
      isPictureBook: nullableFlag(row.ZISPICTUREBOOK),
      isReadAloud: nullableFlag(row.ZISREADALOUD),
      purchaseHistoryId: integer(row.ZPURCHASEHISTORYID),
      storeAccountId: integer(row.ZSTOREACCOUNTID),
      artworkUrl: text(row.ZARTWORKURLSTRING)
    }));
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
};

// packages/sdks/apple/books/dist/books-themes.js
var themesColumns = {
  ZBOOKTHEME: [
    "ZIDENTIFIER",
    "ZHASCUSTOMLAYOUT",
    "ZISFONTBOLDED",
    "ZJUSTIFY",
    "ZMULTIPLECOLUMNMODE",
    "ZLETTERSPACING",
    "ZLINEHEIGHT",
    "ZMARGINADJUSTMENT",
    "ZWORDSPACING"
  ]
};
var BooksThemes = class {
  #database;
  constructor(path) {
    this.#database = new AppDatabase(path, BooksUnavailableError);
    this.#database.requireColumns(themesColumns, BooksSchemaError);
  }
  themes() {
    return this.#database.all("SELECT * FROM ZBOOKTHEME WHERE ZIDENTIFIER IS NOT NULL ORDER BY Z_PK").map((row) => ({
      id: stored(row.ZIDENTIFIER),
      hasCustomLayout: nullableFlag(row.ZHASCUSTOMLAYOUT),
      boldText: nullableFlag(row.ZISFONTBOLDED),
      justify: nullableFlag(row.ZJUSTIFY),
      multipleColumns: nullableFlag(row.ZMULTIPLECOLUMNMODE),
      letterSpacing: number(row.ZLETTERSPACING),
      lineHeight: number(row.ZLINEHEIGHT),
      marginAdjustment: number(row.ZMARGINADJUSTMENT),
      wordSpacing: number(row.ZWORDSPACING)
    }));
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
};

// packages/sdks/apple/books/dist/books-version.js
import { stat } from "node:fs/promises";
async function fingerprint(path) {
  try {
    const { ino, size, mtimeMs } = await stat(path);
    return `${ino}:${size}:${mtimeMs}`;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return "missing";
    throw error;
  }
}
var BooksVersion = class {
  #location;
  #database;
  constructor(location, store) {
    this.#location = location;
    this.#database = store === "preferences" ? null : new AppDatabaseVersion(storeFiles(location)[store], BooksUnavailableError);
  }
  async current() {
    if (this.#database !== null)
      return String(this.#database.current);
    return `${await fingerprint(storeFiles(this.#location).preferences)}|${await fingerprint(sharedPreferences(this.#location))}`;
  }
  [Symbol.dispose]() {
    this.#database?.[Symbol.dispose]();
  }
};

// packages/sdks/apple/books/dist/reading-goal.js
import { readFile } from "node:fs/promises";
async function readBooksPlist(path) {
  let bytes2;
  try {
    bytes2 = await readFile(path);
  } catch (cause) {
    throw new BooksUnavailableError(path, cause);
  }
  if (!isBinaryPlist(bytes2))
    throw new BooksSchemaError(path, ["binary property list"]);
  return parseBinaryPlist(bytes2);
}
async function readingGoal(appPath, sharedPath) {
  const app = dictionary(await readBooksPlist(appPath));
  const shared = dictionary(await readBooksPlist(sharedPath));
  const goal = dictionary(shared.streakDatUserDefaultsKey);
  const appGoal = dictionary(app["ReadingGoals.StreakDay"]);
  const enabled = shared.BKReadingGoalsUserDefaultsKey;
  return {
    enabled: typeof enabled === "boolean" ? enabled : null,
    dailyGoalSeconds: integer(appGoal.goal) ?? integer(goal.goal),
    goalSetAt: plistTime(goal.date) ?? plistTime(appGoal.date),
    currentStreakDays: integer(app["ReadingHistory.CurrentStreak"])
  };
}

// packages/sdks/apple/books/dist/reading-history.js
var magic = "crdt";
var supportedVersion = 4;
var Layout = class {
  source;
  constructor(source) {
    this.source = source;
  }
  fail(what) {
    throw new BooksSchemaError(this.source, [`reading history ${what}`]);
  }
  need(value, what) {
    return value === void 0 ? this.fail(what) : value;
  }
};
function fields(crdt, layout) {
  const struct = layout.need(crdt.message(4), "struct");
  return new Map(struct.messages(1).map((field) => [
    layout.need(field.string(1), "struct field name"),
    layout.need(field.message(2), "struct field value")
  ]));
}
var registerValue = (crdt, layout) => layout.need(layout.need(crdt.message(1), "register").message(3), "register value");
var integer2 = (value, layout) => layout.need(value.int(1), "integer value");
var reference = (value, layout) => Buffer.from(layout.need(layout.need(value.message(6), "reference").bytes(1), "reference id")).toString("hex");
function dictionary2(crdt, layout) {
  const map = layout.need(crdt.message(3), "dictionary");
  return map.messages(3).map((entry) => [
    integer2(layout.need(entry.message(1), "dictionary key"), layout),
    registerValue(layout.need(entry.message(2), "dictionary value"), layout)
  ]);
}
function counter(crdt, layout) {
  const value = layout.need(crdt.message(7), "counter");
  let total = 0;
  for (const replicas of value.messages(2))
    for (const replica of replicas.messages(1)) {
      const parts = varints(layout.need(replica.bytes(2), "counter value"));
      const [decrements, increments] = parts;
      if (parts.length !== 2 || decrements === void 0 || increments === void 0)
        layout.fail("counter value");
      total += increments - decrements;
    }
  return total;
}
function varints(bytes2) {
  const values = [];
  let value = 0n;
  let shift = 0n;
  for (const byte of bytes2) {
    value |= BigInt(byte & 127) << shift;
    if ((byte & 128) === 0) {
      values.push(Number(value));
      value = 0n;
      shift = 0n;
    } else
      shift += 7n;
  }
  return values;
}
function decode(bytes2, source) {
  const layout = new Layout(source);
  if (bytes2.length < 8 || Buffer.from(bytes2.subarray(0, 4)).toString("latin1") !== magic)
    layout.fail("signature");
  const version = Buffer.from(bytes2.subarray(4, 8)).readUInt32LE(0);
  if (version !== supportedVersion)
    layout.fail(`format version ${version}`);
  const document = new ProtobufMessage(bytes2.subarray(8));
  const objects = new Map(document.messages(2).map((object2) => [
    Buffer.from(layout.need(object2.bytes(1), "object id")).toString("hex"),
    layout.need(object2.message(3), "object value")
  ]));
  const object = (id) => layout.need(objects.get(id), "object");
  const root = fields(layout.need(document.message(1), "root"), layout);
  const months = [];
  const days = [];
  for (const [key, value] of dictionary2(layout.need(root.get("months"), "months"), layout)) {
    const year = Math.trunc(key / 100);
    const month = key % 100;
    if (month < 1 || month > 12)
      layout.fail(`month key ${key}`);
    const monthFields = fields(object(reference(value, layout)), layout);
    const total = monthFields.get("totalTime");
    const streak = monthFields.get("lastDayStreakOrdinal");
    const monthDays = dictionary2(layout.need(monthFields.get("days"), "month days"), layout);
    months.push({
      year,
      month,
      totalTime: total === void 0 ? null : integer2(registerValue(total, layout), layout),
      lastDayStreakOrdinal: streak === void 0 ? null : integer2(registerValue(streak, layout), layout),
      dayCount: monthDays.length
    });
    for (const [day, dayValue] of monthDays) {
      const dayFields = fields(object(reference(dayValue, layout)), layout);
      const goal = dayFields.get("readingGoal");
      days.push({
        year,
        month,
        day,
        readingTime: counter(layout.need(dayFields.get("readingTime"), "readingTime"), layout),
        readingGoal: goal === void 0 ? null : integer2(registerValue(goal, layout), layout)
      });
    }
  }
  const streaks = dictionary2(layout.need(root.get("streakRecords"), "streakRecords"), layout).map(([days2, value]) => ({
    days: days2,
    reachedAt: new Date(layout.need(layout.need(value.message(5), "date").int(1), "date seconds") * 1e3)
  }));
  return { months, days, streaks };
}
var readingHistoryColumns = {
  ZCRDTMODELSYNCENTITY: ["ZTYPE", "ZDELETEDFLAG", "ZPROTODATA"]
};
var noHistory = { months: [], days: [], streaks: [] };
function readingHistory(path) {
  var _stack = [];
  try {
    const database = __using(_stack, new AppDatabase(path, BooksUnavailableError));
    database.requireColumns(readingHistoryColumns, BooksSchemaError);
    const rows = database.all("SELECT ZPROTODATA FROM ZCRDTMODELSYNCENTITY WHERE ZTYPE = 'ReadingHistoryModel' AND coalesce(ZDELETEDFLAG, 0) = 0");
    if (rows.length > 1)
      throw new BooksSchemaError(path, [
        `a single live reading history document (${rows.length} found)`
      ]);
    const bytes2 = rows[0]?.ZPROTODATA ?? null;
    if (bytes2 === null)
      return noHistory;
    if (!(bytes2 instanceof Uint8Array))
      throw new BooksSchemaError(path, ["reading history document bytes"]);
    return decode(bytes2, path);
  } catch (_) {
    var _error = _, _hasError = true;
  } finally {
    __callDispose(_stack, _error, _hasError);
  }
}

// packages/sdks/apple/books/dist/books.js
var Books = class {
  location;
  constructor(location) {
    this.location = location;
  }
  library() {
    return new BooksLibrary(storeFiles(this.location).library);
  }
  annotations() {
    return new BooksAnnotations(storeFiles(this.location).annotations);
  }
  assetData() {
    return new BookAssetData(storeFiles(this.location).assetData);
  }
  readingHistory() {
    return readingHistory(storeFiles(this.location).readingHistory);
  }
  purchases() {
    return new BooksPurchases(storeFiles(this.location).purchases);
  }
  themes() {
    return new BooksThemes(storeFiles(this.location).themes);
  }
  readingGoal() {
    return readingGoal(storeFiles(this.location).preferences, sharedPreferences(this.location));
  }
  // A probe whose current value changes when the store does.
  version(store) {
    return new BooksVersion(this.location, store);
  }
};

// packages/sources/apple/books/dist/books-scan.js
var BooksScan = class _BooksScan {
  #resources;
  #stores;
  constructor(resources, stores) {
    this.#resources = resources;
    this.#stores = stores;
  }
  static async open(books, stores) {
    var _stack = [];
    try {
      const resources = __using(_stack, new AsyncDisposableStack(), true);
      const open2 = async (store, value) => {
        if (!stores.has(store))
          return void 0;
        try {
          return { value: await value() };
        } catch (error) {
          return { error };
        }
      };
      const opened = {
        library: await open2("library", () => resources.use(books.library())),
        annotations: await open2("annotations", () => resources.use(books.annotations())),
        assetData: await open2("assetData", () => resources.use(books.assetData())),
        // Decoded whole while the read transaction pins it, then released.
        readingHistory: await open2("readingHistory", () => books.readingHistory()),
        purchases: await open2("purchases", () => resources.use(books.purchases())),
        themes: await open2("themes", () => resources.use(books.themes())),
        preferences: await open2("preferences", () => books.readingGoal())
      };
      return new _BooksScan(resources.move(), opened);
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      var _promise = __callDispose(_stack, _error, _hasError);
      _promise && await _promise;
    }
  }
  get library() {
    return this.#value("library");
  }
  get annotations() {
    return this.#value("annotations");
  }
  get assetData() {
    return this.#value("assetData");
  }
  get readingHistory() {
    return this.#value("readingHistory");
  }
  get purchases() {
    return this.#value("purchases");
  }
  get themes() {
    return this.#value("themes");
  }
  get readingGoal() {
    return this.#value("preferences");
  }
  #value(store) {
    const opened = this.#stores[store];
    if (opened === void 0)
      throw new Error(`Books ${store} was not opened for this run`);
    if ("error" in opened)
      throw opened.error;
    return opened.value;
  }
  [Symbol.asyncDispose]() {
    return this.#resources.disposeAsync();
  }
};

// packages/sources/apple/books/dist/books-stream.js
var text2 = { type: "string" };
var nullableText = { type: ["string", "null"] };
var integer3 = { type: "integer" };
var nullableInteger = { type: ["integer", "null"] };
var iso = (date) => date?.toISOString() ?? null;
var base64 = (bytes2) => bytes2 === null ? null : Buffer.from(bytes2).toString("base64");
var booksFields = {
  id: { ...text2, minLength: 1 },
  nullableId: { ...nullableText, minLength: 1 },
  text: text2,
  nullableText,
  integer: integer3,
  nullableInteger,
  nullableNumber: { type: ["number", "null"] },
  boolean: { type: "boolean" },
  nullableBoolean: { type: ["boolean", "null"] },
  timestamp: { ...text2, format: "date-time" },
  nullableTimestamp: { ...nullableText, format: "date-time" },
  date: { ...text2, format: "date" },
  assetId: {
    ...text2,
    minLength: 1,
    description: "Books asset identifier (a 32-character hex string for books added from files); refers to libraryAssets.assetId within this source."
  }
};
var BooksStream = class {
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
    const rows = await this.rows(scan);
    return validateRecords(this, rows.map((row) => this.record(row, scan)), "Books");
  }
  // The file a record carries, for streams that support file reads, staged
  // under staging when it has to be built.
  async file(_record, _scan, _staging) {
    return null;
  }
};

// packages/sources/apple/books/dist/streams/annotations-stream.js
var { boolean, nullableInteger: nullableInteger2, nullableText: nullableText2, nullableTimestamp } = booksFields;
var properties = {
  id: { ...booksFields.id, description: "Annotation UUID." },
  assetId: {
    ...booksFields.nullableId,
    description: "The annotated book; refers to libraryAssets.assetId, or to a book no longer in the library. NULL on deletion markers, which Books keeps without the book."
  },
  kind: {
    ...nullableText2,
    enum: annotationKinds,
    description: "highlight: highlighted or underlined text, with an optional note; readingPosition: where Books last left the book. NULL for any other kind, whose code is in kindCode."
  },
  kindCode: {
    ...nullableInteger2,
    description: "Books annotation type code."
  },
  style: {
    ...nullableInteger2,
    description: "Highlight style: 0 underline (underline is true), 1 green, 2 blue, 3 yellow, 4 pink, 5 purple."
  },
  underline: {
    ...boolean,
    description: "Shown as an underline rather than a highlight."
  },
  deleted: {
    ...boolean,
    description: "Deleted in Books and kept as a marker until the deletion syncs; such rows carry no text or location."
  },
  selectedText: {
    ...nullableText2,
    description: "The highlighted text."
  },
  representativeText: {
    ...nullableText2,
    description: "Surrounding text Books stored for context."
  },
  note: { ...nullableText2, description: "Note the user attached." },
  chapter: {
    ...nullableText2,
    description: "Chapter title at the annotation, as Books stored it."
  },
  location: {
    ...nullableText2,
    description: "Position in the book as an EPUB CFI (epubcfi(...))."
  },
  rangeStart: {
    ...nullableInteger2,
    description: "Start offset of the position within its chapter."
  },
  rangeEnd: {
    ...nullableInteger2,
    description: "End offset of the position within its chapter."
  },
  physicalLocation: {
    ...nullableInteger2,
    description: "Absolute position in the book, for fixed-layout and PDF books."
  },
  storageId: {
    ...nullableText2,
    description: "Books storage identifier of the chapter."
  },
  creator: {
    ...nullableText2,
    description: "App that made the annotation, such as com~apple~iBooks."
  },
  createdAt: { ...nullableTimestamp, description: "When it was made." },
  modifiedAt: {
    ...nullableTimestamp,
    description: "When it last changed."
  }
};
var AnnotationsStream = class extends BooksStream {
  name = "annotations";
  store = "annotations";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One source record per Books annotation: highlights, underlines and notes, and the reading position Books keeps per book, including deletion markers not yet synced. Relationships name streams in this source, not physical destination tables.",
    properties,
    required: Object.keys(properties)
  };
  rows(scan) {
    return scan.annotations.annotations();
  }
  record(annotation) {
    return {
      id: annotation.id,
      assetId: annotation.assetId,
      kind: annotation.kind,
      kindCode: annotation.kindCode,
      style: annotation.style,
      underline: annotation.underline,
      deleted: annotation.deleted,
      selectedText: annotation.selectedText,
      representativeText: annotation.representativeText,
      note: annotation.note,
      chapter: annotation.chapter,
      location: annotation.location,
      rangeStart: annotation.rangeStart,
      rangeEnd: annotation.rangeEnd,
      physicalLocation: annotation.physicalLocation,
      storageId: annotation.storageId,
      creator: annotation.creator,
      createdAt: iso(annotation.createdAt),
      modifiedAt: iso(annotation.modifiedAt)
    };
  }
};

// packages/sources/apple/books/dist/streams/asset-details-stream.js
var { boolean: boolean2, nullableBoolean, nullableInteger: nullableInteger3, nullableNumber, nullableText: nullableText3, nullableTimestamp: nullableTimestamp2 } = booksFields;
var properties2 = {
  assetId: {
    ...booksFields.assetId,
    description: "The book; refers to libraryAssets.assetId when the book is in the library on this Mac. Books on other devices only appear here."
  },
  deleted: {
    ...boolean2,
    description: "Deleted, kept until the deletion syncs."
  },
  readingProgress: {
    ...nullableNumber,
    minimum: 0,
    maximum: 1,
    description: "Fraction of the book read at the synced position, 0 to 1."
  },
  highWaterMarkProgress: {
    ...nullableNumber,
    minimum: 0,
    maximum: 1,
    description: "Furthest fraction of the book ever reached, 0 to 1."
  },
  isFinished: { ...boolean2, description: "Marked as finished." },
  notFinished: {
    ...nullableBoolean,
    description: "Marked as still reading; NULL when unset."
  },
  finishedDateKind: {
    ...nullableInteger3,
    description: "How Books recorded the finished date."
  },
  finishedAt: { ...nullableTimestamp2, description: "When it was finished." },
  isTrackedAsRecent: {
    ...nullableBoolean,
    description: "Listed among recent books."
  },
  lastOpenedAt: { ...nullableTimestamp2, description: "When last opened." },
  lastEngagedAt: {
    ...nullableTimestamp2,
    description: "When the user last engaged with it."
  },
  modifiedAt: {
    ...nullableTimestamp2,
    description: "When this record last changed."
  },
  starRating: {
    ...nullableInteger3,
    description: "Star rating the user gave, 0 when none."
  },
  taste: {
    ...nullableInteger3,
    description: "Suggest more or less like this, as Books records it."
  },
  tasteSyncedToStore: {
    ...nullableBoolean,
    description: "Whether the taste was sent to the store."
  },
  audiobookPosition: {
    ...nullableNumber,
    description: "Playback position in seconds, for audiobooks."
  },
  audiobookPositionUpdatedAt: {
    ...nullableTimestamp2,
    description: "When the playback position last changed."
  },
  position: {
    ...nullableText3,
    description: "Synced reading position as an EPUB CFI (epubcfi(...))."
  },
  positionRangeStart: {
    ...nullableInteger3,
    description: "Start offset of the position within its chapter."
  },
  positionRangeEnd: {
    ...nullableInteger3,
    description: "End offset of the position within its chapter."
  },
  positionPhysicalLocation: {
    ...nullableInteger3,
    description: "Absolute position, for fixed-layout and PDF books."
  },
  positionStorageId: {
    ...nullableText3,
    description: "Books storage identifier of the chapter at the position."
  },
  positionAssetVersion: {
    ...nullableText3,
    description: "Book version the position refers to."
  },
  positionAnnotationVersion: {
    ...nullableText3,
    description: "Annotation format version of the position."
  },
  positionUpdatedAt: {
    ...nullableTimestamp2,
    description: "When the position last moved."
  }
};
var AssetDetailsStream = class extends BooksStream {
  name = "assetDetails";
  store = "assetData";
  primaryKey = ["assetId"];
  jsonSchema = {
    type: "object",
    description: "One source record per book with reading state that Books syncs through iCloud: progress, finished state, rating and position. Covers books read on other devices that are not in this Mac's library. Relationships name streams in this source, not physical destination tables.",
    properties: properties2,
    required: Object.keys(properties2)
  };
  rows(scan) {
    return scan.assetData.details();
  }
  record(detail) {
    return {
      assetId: detail.assetId,
      deleted: detail.deleted,
      readingProgress: detail.readingProgress,
      highWaterMarkProgress: detail.highWaterMarkProgress,
      isFinished: detail.isFinished,
      notFinished: detail.notFinished,
      finishedDateKind: detail.finishedDateKind,
      finishedAt: iso(detail.finishedAt),
      isTrackedAsRecent: detail.isTrackedAsRecent,
      lastOpenedAt: iso(detail.lastOpenedAt),
      lastEngagedAt: iso(detail.lastEngagedAt),
      modifiedAt: iso(detail.modifiedAt),
      starRating: detail.starRating,
      taste: detail.taste,
      tasteSyncedToStore: detail.tasteSyncedToStore,
      audiobookPosition: detail.audiobookPosition,
      audiobookPositionUpdatedAt: iso(detail.audiobookPositionUpdatedAt),
      position: detail.position,
      positionRangeStart: detail.positionRangeStart,
      positionRangeEnd: detail.positionRangeEnd,
      positionPhysicalLocation: detail.positionPhysicalLocation,
      positionStorageId: detail.positionStorageId,
      positionAssetVersion: detail.positionAssetVersion,
      positionAnnotationVersion: detail.positionAnnotationVersion,
      positionUpdatedAt: iso(detail.positionUpdatedAt)
    };
  }
};

// packages/sources/apple/books/dist/streams/book-files-stream.js
import { join as join3 } from "node:path";
var { boolean: boolean3, nullableInteger: nullableInteger4, nullableTimestamp: nullableTimestamp3 } = booksFields;
var properties3 = {
  assetId: booksFields.assetId,
  path: {
    ...booksFields.text,
    description: "Where Books keeps the file on this Mac, usually in iCloud Drive. An EPUB is a package directory there."
  },
  format: {
    ...booksFields.text,
    enum: bookFileFormats,
    description: "epub-package: an unzipped EPUB directory, exported as one .epub file; file: a single file such as a PDF or a zipped .epub, exported as it is. For a placeholder, read from the path's extension."
  },
  availableLocally: {
    ...boolean3,
    description: "Whether the book's exportable file is wholly on this Mac. False for an iCloud Drive placeholder, which the export never opens, a missing path, or a directory that is not an EPUB package."
  },
  fileCount: {
    ...nullableInteger4,
    description: "Files in the package, or 1 for a single file; NULL when not available locally."
  },
  sizeBytes: {
    ...nullableInteger4,
    description: "Total bytes on disk of the file or the package contents; NULL when not available locally."
  },
  modifiedAt: {
    ...nullableTimestamp3,
    description: "Latest modification time of the file or any file in the package; NULL when not available locally."
  }
};
var BookFilesStream = class extends BooksStream {
  name = "bookFiles";
  store = "library";
  primaryKey = ["assetId"];
  supportsFileTransfer = true;
  jsonSchema = {
    type: "object",
    description: "One source record per library asset that has a file path, with the book file when its bytes are on this Mac. iCloud Drive placeholders are reported, never downloaded. Relationships name streams in this source, not physical destination tables.",
    properties: properties3,
    required: Object.keys(properties3)
  };
  rows(scan) {
    return scan.library.bookFiles();
  }
  record(file) {
    return {
      assetId: file.assetId,
      path: file.path,
      format: file.format,
      availableLocally: file.availableLocally,
      fileCount: file.fileCount,
      sizeBytes: file.sizeBytes,
      modifiedAt: iso(file.modifiedAt)
    };
  }
  // A single file is exported as it is; a package is written as one .epub
  // under staging.
  async file(record, _scan, staging) {
    if (!record.availableLocally)
      return null;
    return exportBookFile(record.path, join3(staging, `${record.assetId}.epub`));
  }
};

// packages/sources/apple/books/dist/streams/collection-members-stream.js
var properties4 = {
  collectionId: {
    ...booksFields.id,
    description: "The collection; refers to collections.collectionId."
  },
  assetId: {
    ...booksFields.assetId,
    description: "The member; refers to libraryAssets.assetId, or to an asset no longer in the library."
  },
  sortKey: {
    ...booksFields.nullableInteger,
    description: "Position within the collection when sorted manually."
  },
  addedAt: {
    ...booksFields.nullableTimestamp,
    description: "When the member was added or last moved on this Mac."
  }
};
var CollectionMembersStream = class extends BooksStream {
  name = "collectionMembers";
  store = "library";
  primaryKey = ["collectionId", "assetId"];
  jsonSchema = {
    type: "object",
    description: "One source record per book in a Books collection. Membership names the asset by its identifier, so it outlives the asset leaving the library. Relationships name streams in this source, not physical destination tables.",
    properties: properties4,
    required: Object.keys(properties4)
  };
  rows(scan) {
    return scan.library.collectionMembers();
  }
  record(member) {
    return {
      collectionId: member.collectionId,
      assetId: member.assetId,
      sortKey: member.sortKey,
      addedAt: iso(member.addedAt)
    };
  }
};

// packages/sources/apple/books/dist/streams/collections-stream.js
var { boolean: boolean4, nullableInteger: nullableInteger5, nullableText: nullableText4, nullableTimestamp: nullableTimestamp4 } = booksFields;
var properties5 = {
  collectionId: {
    ...booksFields.id,
    description: "Collection identifier: a fixed name such as Finished_Collection_ID for a built-in collection, a UUID for one the user made."
  },
  title: { ...nullableText4, description: "Collection name." },
  details: { ...nullableText4, description: "Collection description." },
  deleted: {
    ...boolean4,
    description: "Deleted, kept until the deletion syncs."
  },
  hidden: { ...boolean4, description: "Hidden from the sidebar." },
  placeholder: {
    ...boolean4,
    description: "A placeholder Books keeps for a built-in collection."
  },
  sortKey: { ...nullableInteger5, description: "Position in the sidebar." },
  sortMode: {
    ...nullableInteger5,
    description: "How the collection sorts its books, as a Books code."
  },
  viewMode: {
    ...nullableInteger5,
    description: "Grid or list, as a Books code."
  },
  modifiedAt: {
    ...nullableTimestamp4,
    description: "When the collection last changed."
  },
  localModifiedAt: {
    ...nullableTimestamp4,
    description: "When the collection last changed on this Mac."
  }
};
var CollectionsStream = class extends BooksStream {
  name = "collections";
  store = "library";
  primaryKey = ["collectionId"];
  jsonSchema = {
    type: "object",
    description: "One source record per Books collection, built-in or made by the user; members are in collectionMembers. Relationships name streams in this source, not physical destination tables.",
    properties: properties5,
    required: Object.keys(properties5)
  };
  rows(scan) {
    return scan.library.collections();
  }
  record(collection) {
    return {
      collectionId: collection.collectionId,
      title: collection.title,
      details: collection.details,
      deleted: collection.deleted,
      hidden: collection.hidden,
      placeholder: collection.placeholder,
      sortKey: collection.sortKey,
      sortMode: collection.sortMode,
      viewMode: collection.viewMode,
      modifiedAt: iso(collection.modifiedAt),
      localModifiedAt: iso(collection.localModifiedAt)
    };
  }
};

// packages/sources/apple/books/dist/streams/library-assets-stream.js
var { boolean: boolean5, nullableBoolean: nullableBoolean2, nullableInteger: nullableInteger6, nullableNumber: nullableNumber2, nullableText: nullableText5, nullableTimestamp: nullableTimestamp5 } = booksFields;
var properties6 = {
  assetId: booksFields.assetId,
  title: { ...nullableText5, description: "Title." },
  sortTitle: { ...nullableText5, description: "Title Books sorts by." },
  author: { ...nullableText5, description: "Author as displayed." },
  sortAuthor: { ...nullableText5, description: "Author Books sorts by." },
  authorCount: { ...nullableInteger6, description: "Number of authors." },
  authorNames: {
    ...nullableText5,
    description: "Author names as Books archives them, base64-encoded; NULL when not recorded."
  },
  narratorCount: {
    ...nullableInteger6,
    description: "Number of narrators, for audiobooks."
  },
  narratorNames: {
    ...nullableText5,
    description: "Narrator names as Books archives them, base64-encoded; NULL when not recorded."
  },
  genre: { ...nullableText5, description: "Primary genre." },
  genres: {
    ...nullableText5,
    description: "All genres as Books archives them, base64-encoded; NULL when not recorded."
  },
  language: { ...nullableText5, description: "Language code of the book." },
  bookDescription: {
    ...nullableText5,
    description: "Description from the book or store."
  },
  comments: { ...nullableText5, description: "Comments from the book file." },
  grouping: { ...nullableText5, description: "Grouping from the book file." },
  year: { ...nullableText5, description: "Publication year as recorded." },
  kind: { ...nullableText5, description: "Store kind of the item." },
  contentType: {
    ...nullableText5,
    enum: contentTypes,
    description: "What the asset is: epub or pdf; NULL for any other kind, whose code is in contentTypeCode."
  },
  contentTypeCode: {
    ...nullableInteger6,
    description: "Books content type code behind contentType."
  },
  mappedAssetId: {
    ...nullableText5,
    description: "Asset this one maps to, such as the store book a sample or file matched; refers to libraryAssets.assetId."
  },
  mappedAssetContentTypeCode: {
    ...nullableInteger6,
    description: "Content type code of the mapped asset."
  },
  temporaryAssetId: {
    ...nullableText5,
    description: "Identifier Books used before the asset had its own."
  },
  epubId: {
    ...nullableText5,
    description: "Unique identifier declared inside the EPUB package."
  },
  assetGuid: { ...nullableText5, description: "Books asset GUID." },
  storeId: {
    ...nullableText5,
    description: "Apple Books store item ID; NULL for books added from files."
  },
  storePlaylistId: {
    ...nullableText5,
    description: "Store playlist ID, for audiobooks."
  },
  familyId: {
    ...nullableText5,
    description: "Family Sharing member that bought the book."
  },
  accountId: { ...nullableText5, description: "Store account ID." },
  purchasedDsid: {
    ...nullableText5,
    description: "Store account ID that purchased the book."
  },
  downloadedDsid: {
    ...nullableText5,
    description: "Store account ID that downloaded the book."
  },
  dataSource: {
    ...nullableText5,
    description: "Where Books found the asset, such as com.apple.ibooks.datasource.ubiquity for iCloud Drive."
  },
  path: {
    ...nullableText5,
    description: "Where the book file lives on this Mac; may be an iCloud Drive placeholder. See bookFiles."
  },
  url: { ...nullableText5, description: "Store URL." },
  permalink: { ...nullableText5, description: "Store permalink." },
  coverUrl: { ...nullableText5, description: "Store cover image URL." },
  coverAspectRatio: {
    ...nullableNumber2,
    description: "Cover width divided by height."
  },
  coverWritingMode: {
    ...nullableText5,
    description: "Writing mode of the cover."
  },
  pageProgressionDirection: {
    ...nullableText5,
    description: "Page turn direction declared by the book: ltr or rtl."
  },
  pageCount: { ...nullableInteger6, description: "Number of pages." },
  fileSize: { ...nullableInteger6, description: "File size in bytes." },
  duration: {
    ...nullableNumber2,
    description: "Length in seconds, for audiobooks."
  },
  readingProgress: {
    ...nullableNumber2,
    minimum: 0,
    maximum: 1,
    description: "Fraction of the book read at the current position, 0 to 1."
  },
  highWaterMarkProgress: {
    ...nullableNumber2,
    minimum: 0,
    maximum: 1,
    description: "Furthest fraction of the book ever reached, 0 to 1."
  },
  isFinished: { ...boolean5, description: "Marked as finished." },
  notFinished: {
    ...nullableBoolean2,
    description: "Marked as still reading after being finished; NULL when unset."
  },
  finishedDateKind: {
    ...nullableInteger6,
    description: "How Books recorded the finished date."
  },
  finishedAt: { ...nullableTimestamp5, description: "When it was finished." },
  lastOpenedAt: { ...nullableTimestamp5, description: "When last opened." },
  lastEngagedAt: {
    ...nullableTimestamp5,
    description: "When the user last engaged with it."
  },
  createdAt: {
    ...nullableTimestamp5,
    description: "When this library entry was created."
  },
  modifiedAt: {
    ...nullableTimestamp5,
    description: "When this library entry last changed."
  },
  purchasedAt: {
    ...nullableTimestamp5,
    description: "When it was bought, or added to the library for books added from files."
  },
  releasedAt: { ...nullableTimestamp5, description: "Release date." },
  updatedAt: {
    ...nullableTimestamp5,
    description: "When the book file was last updated."
  },
  expectedAt: {
    ...nullableTimestamp5,
    description: "Expected release, for preorders."
  },
  rating: { ...nullableInteger6, description: "User rating." },
  computedRating: {
    ...nullableInteger6,
    description: "Rating Books computed."
  },
  taste: {
    ...nullableInteger6,
    description: "Suggest more or less like this, as Books records it."
  },
  tasteSyncedToStore: {
    ...nullableBoolean2,
    description: "Whether the taste was sent to the store."
  },
  isSample: { ...boolean5, description: "A store sample." },
  isExplicit: { ...nullableBoolean2, description: "Marked explicit." },
  isHidden: { ...boolean5, description: "Hidden from the library." },
  isLocked: { ...nullableBoolean2, description: "Locked by Books." },
  isNew: { ...nullableBoolean2, description: "Shown as new." },
  isProof: { ...nullableBoolean2, description: "A proof copy." },
  isDevelopment: {
    ...nullableBoolean2,
    description: "A development build of a book."
  },
  isEphemeral: {
    ...nullableBoolean2,
    description: "Opened without being added to the library."
  },
  isStoreAudiobook: {
    ...nullableBoolean2,
    description: "An audiobook bought from the store."
  },
  isSupplementalContent: {
    ...nullableBoolean2,
    description: "Supplemental material of another asset."
  },
  supplementalContentParentAssetId: {
    ...nullableText5,
    description: "Asset this supplemental content belongs to; refers to libraryAssets.assetId."
  },
  isTrackedAsRecent: {
    ...nullableBoolean2,
    description: "Listed among recent books."
  },
  canRedownload: {
    ...nullableBoolean2,
    description: "Can be downloaded again from the store."
  },
  hasReadAloudSupport: {
    ...nullableBoolean2,
    description: "Supports read-aloud."
  },
  desktopSupportLevel: {
    ...nullableInteger6,
    description: "How well Books on Mac supports the book."
  },
  state: {
    ...nullableInteger6,
    description: "Books library state code. Not whether the file is on this Mac; see bookFiles.availableLocally."
  },
  combinedState: {
    ...nullableInteger6,
    description: "Books combined library state code."
  },
  versionNumber: { ...nullableNumber2, description: "Store version number." },
  version: {
    ...nullableText5,
    description: "Store version as displayed."
  },
  seriesId: { ...nullableText5, description: "Store series ID." },
  seriesContainerAssetId: {
    ...nullableText5,
    description: "Series this book belongs to in the library; refers to libraryAssets.assetId."
  },
  sequenceNumber: {
    ...nullableNumber2,
    description: "Position in the series."
  },
  sequenceDisplayName: {
    ...nullableText5,
    description: "Position in the series as displayed."
  },
  seriesIsOrdered: {
    ...nullableBoolean2,
    description: "For a series, whether its books have an order."
  },
  seriesIsHidden: {
    ...nullableBoolean2,
    description: "For a series, whether it is hidden."
  },
  seriesIsCloudOnly: {
    ...nullableBoolean2,
    description: "For a series, whether only the store lists it."
  }
};
var LibraryAssetsStream = class extends BooksStream {
  name = "libraryAssets";
  store = "library";
  primaryKey = ["assetId"];
  jsonSchema = {
    type: "object",
    description: "One source record per book, PDF, audiobook or series in the Books library on this Mac (BKLibrary). Reading state that syncs across devices, including books not in this library, is in assetDetails. Relationships name streams in this source, not physical destination tables.",
    properties: properties6,
    required: Object.keys(properties6)
  };
  rows(scan) {
    return scan.library.assets();
  }
  record(asset) {
    return {
      assetId: asset.assetId,
      title: asset.title,
      sortTitle: asset.sortTitle,
      author: asset.author,
      sortAuthor: asset.sortAuthor,
      authorCount: asset.authorCount,
      authorNames: base64(asset.authorNames),
      narratorCount: asset.narratorCount,
      narratorNames: base64(asset.narratorNames),
      genre: asset.genre,
      genres: base64(asset.genres),
      language: asset.language,
      bookDescription: asset.bookDescription,
      comments: asset.comments,
      grouping: asset.grouping,
      year: asset.year,
      kind: asset.kind,
      contentType: asset.contentType,
      contentTypeCode: asset.contentTypeCode,
      mappedAssetId: asset.mappedAssetId,
      mappedAssetContentTypeCode: asset.mappedAssetContentTypeCode,
      temporaryAssetId: asset.temporaryAssetId,
      epubId: asset.epubId,
      assetGuid: asset.assetGuid,
      storeId: asset.storeId,
      storePlaylistId: asset.storePlaylistId,
      familyId: asset.familyId,
      accountId: asset.accountId,
      purchasedDsid: asset.purchasedDsid,
      downloadedDsid: asset.downloadedDsid,
      dataSource: asset.dataSource,
      path: asset.path,
      url: asset.url,
      permalink: asset.permalink,
      coverUrl: asset.coverUrl,
      coverAspectRatio: asset.coverAspectRatio,
      coverWritingMode: asset.coverWritingMode,
      pageProgressionDirection: asset.pageProgressionDirection,
      pageCount: asset.pageCount,
      fileSize: asset.fileSize,
      duration: asset.duration,
      readingProgress: asset.readingProgress,
      highWaterMarkProgress: asset.highWaterMarkProgress,
      isFinished: asset.isFinished,
      notFinished: asset.notFinished,
      finishedDateKind: asset.finishedDateKind,
      finishedAt: iso(asset.finishedAt),
      lastOpenedAt: iso(asset.lastOpenedAt),
      lastEngagedAt: iso(asset.lastEngagedAt),
      createdAt: iso(asset.createdAt),
      modifiedAt: iso(asset.modifiedAt),
      purchasedAt: iso(asset.purchasedAt),
      releasedAt: iso(asset.releasedAt),
      updatedAt: iso(asset.updatedAt),
      expectedAt: iso(asset.expectedAt),
      rating: asset.rating,
      computedRating: asset.computedRating,
      taste: asset.taste,
      tasteSyncedToStore: asset.tasteSyncedToStore,
      isSample: asset.isSample,
      isExplicit: asset.isExplicit,
      isHidden: asset.isHidden,
      isLocked: asset.isLocked,
      isNew: asset.isNew,
      isProof: asset.isProof,
      isDevelopment: asset.isDevelopment,
      isEphemeral: asset.isEphemeral,
      isStoreAudiobook: asset.isStoreAudiobook,
      isSupplementalContent: asset.isSupplementalContent,
      supplementalContentParentAssetId: asset.supplementalContentParentAssetId,
      isTrackedAsRecent: asset.isTrackedAsRecent,
      canRedownload: asset.canRedownload,
      hasReadAloudSupport: asset.hasReadAloudSupport,
      desktopSupportLevel: asset.desktopSupportLevel,
      state: asset.state,
      combinedState: asset.combinedState,
      versionNumber: asset.versionNumber,
      version: asset.version,
      seriesId: asset.seriesId,
      seriesContainerAssetId: asset.seriesContainerAssetId,
      sequenceNumber: asset.sequenceNumber,
      sequenceDisplayName: asset.sequenceDisplayName,
      seriesIsOrdered: asset.seriesIsOrdered,
      seriesIsHidden: asset.seriesIsHidden,
      seriesIsCloudOnly: asset.seriesIsCloudOnly
    };
  }
};

// packages/sources/apple/books/dist/streams/purchases-stream.js
var { nullableBoolean: nullableBoolean3, nullableInteger: nullableInteger7, nullableText: nullableText6, nullableTimestamp: nullableTimestamp6 } = booksFields;
var properties7 = {
  storeId: {
    ...booksFields.id,
    description: "Apple Books store item ID; refers to libraryAssets.storeId when the purchase is in the library on this Mac."
  },
  title: { ...nullableText6, description: "Title." },
  sortTitle: { ...nullableText6, description: "Title the store sorts by." },
  artist: { ...nullableText6, description: "Author or narrator." },
  sortAuthor: { ...nullableText6, description: "Author the store sorts by." },
  genre: { ...nullableText6, description: "Genre." },
  fileExtension: {
    ...nullableText6,
    description: "Extension of the downloadable file, such as epub or m4b."
  },
  version: { ...nullableText6, description: "Store version as displayed." },
  purchasedAt: { ...nullableTimestamp6, description: "When it was bought." },
  expectedAt: {
    ...nullableTimestamp6,
    description: "Expected release, for preorders."
  },
  isAudiobook: { ...nullableBoolean3, description: "An audiobook." },
  containsAudio: { ...nullableBoolean3, description: "Contains audio." },
  isExplicit: { ...nullableBoolean3, description: "Marked explicit." },
  isHidden: {
    ...nullableBoolean3,
    description: "Hidden from the purchased list."
  },
  isDisabled: {
    ...nullableBoolean3,
    description: "No longer available to download."
  },
  isPictureBook: { ...nullableBoolean3, description: "A picture book." },
  isReadAloud: {
    ...nullableBoolean3,
    description: "Has read-aloud narration."
  },
  purchaseHistoryId: {
    ...nullableInteger7,
    description: "Store purchase history identifier."
  },
  storeAccountId: {
    ...nullableInteger7,
    description: "Store account that bought it."
  },
  artworkUrl: {
    ...nullableText6,
    description: "Store artwork URL template."
  }
};
var PurchasesStream = class extends BooksStream {
  name = "purchases";
  store = "purchases";
  primaryKey = ["storeId"];
  jsonSchema = {
    type: "object",
    description: "One source record per book or audiobook the Apple Account bought in the Books store, downloaded or not. Download tokens and DRM parameters are left out. Relationships name streams in this source, not physical destination tables.",
    properties: properties7,
    required: Object.keys(properties7)
  };
  rows(scan) {
    return scan.purchases.purchases();
  }
  record(purchase) {
    return {
      storeId: purchase.storeId,
      title: purchase.title,
      sortTitle: purchase.sortTitle,
      artist: purchase.artist,
      sortAuthor: purchase.sortAuthor,
      genre: purchase.genre,
      fileExtension: purchase.fileExtension,
      version: purchase.version,
      purchasedAt: iso(purchase.purchasedAt),
      expectedAt: iso(purchase.expectedAt),
      isAudiobook: purchase.isAudiobook,
      containsAudio: purchase.containsAudio,
      isExplicit: purchase.isExplicit,
      isHidden: purchase.isHidden,
      isDisabled: purchase.isDisabled,
      isPictureBook: purchase.isPictureBook,
      isReadAloud: purchase.isReadAloud,
      purchaseHistoryId: purchase.purchaseHistoryId,
      storeAccountId: purchase.storeAccountId,
      artworkUrl: purchase.artworkUrl
    };
  }
};

// packages/sources/apple/books/dist/streams/reading-goal-stream.js
var { nullableBoolean: nullableBoolean4, nullableInteger: nullableInteger8, nullableTimestamp: nullableTimestamp7 } = booksFields;
var properties8 = {
  id: {
    ...booksFields.id,
    enum: ["current"],
    description: "Always current: Books keeps one reading goal."
  },
  enabled: {
    ...nullableBoolean4,
    description: "Whether reading goals are turned on; NULL when never set."
  },
  dailyGoalSeconds: {
    ...nullableInteger8,
    minimum: 0,
    description: "Daily reading goal in seconds; NULL when never set."
  },
  goalSetAt: {
    ...nullableTimestamp7,
    description: "When the daily goal was last set."
  },
  currentStreakDays: {
    ...nullableInteger8,
    minimum: 0,
    description: "Consecutive days the goal has been met, as Books last computed it."
  }
};
var ReadingGoalStream = class extends BooksStream {
  name = "readingGoal";
  store = "preferences";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "The Books reading goal and current streak, one record, from Books' preferences. Daily reading time is in readingDays. Relationships name streams in this source, not physical destination tables.",
    properties: properties8,
    required: Object.keys(properties8)
  };
  rows(scan) {
    return [scan.readingGoal];
  }
  record(goal) {
    return {
      id: "current",
      enabled: goal.enabled,
      dailyGoalSeconds: goal.dailyGoalSeconds,
      goalSetAt: iso(goal.goalSetAt),
      currentStreakDays: goal.currentStreakDays
    };
  }
};

// packages/sources/apple/books/dist/streams/reading-history-streams.js
var { nullableInteger: nullableInteger9 } = booksFields;
var pad = (value) => String(value).padStart(2, "0");
var monthProperties = {
  month: {
    ...booksFields.text,
    description: "Calendar month, YYYY-MM, in the time zone Books read in."
  },
  summarizedSeconds: {
    ...nullableInteger9,
    minimum: 0,
    description: "Reading time Books kept for the month after summarizing it, in seconds. NULL while the month is not summarized; its days are then in readingDays."
  },
  lastDayStreakOrdinal: {
    ...nullableInteger9,
    description: "Books' marker of the month's last streak day, as it stores it; -1 when none."
  },
  dayCount: {
    ...booksFields.integer,
    minimum: 0,
    description: "Days of the month still kept in readingDays; 0 once Books has summarized and pruned them."
  }
};
var ReadingMonthsStream = class extends BooksStream {
  name = "readingMonths";
  store = "readingHistory";
  primaryKey = ["month"];
  jsonSchema = {
    type: "object",
    description: "One source record per month in Books' reading history, which counts time with a book open for reading goals. Older months keep only a summarized total. Relationships name streams in this source, not physical destination tables.",
    properties: monthProperties,
    required: Object.keys(monthProperties)
  };
  rows(scan) {
    return scan.readingHistory.months;
  }
  record(month) {
    return {
      month: `${month.year}-${pad(month.month)}`,
      summarizedSeconds: month.totalTime,
      lastDayStreakOrdinal: month.lastDayStreakOrdinal,
      dayCount: month.dayCount
    };
  }
};
var dayProperties = {
  date: {
    ...booksFields.date,
    description: "Calendar day, in the time zone Books read in."
  },
  month: {
    ...booksFields.text,
    description: "The day's month; refers to readingMonths.month."
  },
  readingSeconds: {
    ...booksFields.integer,
    minimum: 0,
    description: "Time spent reading that day, in seconds, summed over every device that synced it."
  },
  goalSeconds: {
    ...nullableInteger9,
    minimum: 0,
    description: "Daily reading goal in effect that day, in seconds."
  }
};
var ReadingDaysStream = class extends BooksStream {
  name = "readingDays";
  store = "readingHistory";
  primaryKey = ["date"];
  jsonSchema = {
    type: "object",
    description: "One source record per day Books still keeps in its reading history, with the time read and the goal. Books summarizes older months into readingMonths and drops their days. Relationships name streams in this source, not physical destination tables.",
    properties: dayProperties,
    required: Object.keys(dayProperties)
  };
  rows(scan) {
    return scan.readingHistory.days;
  }
  record(day) {
    const month = `${day.year}-${pad(day.month)}`;
    return {
      date: `${month}-${pad(day.day)}`,
      month,
      readingSeconds: day.readingTime,
      goalSeconds: day.readingGoal
    };
  }
};
var streakProperties = {
  days: {
    ...booksFields.integer,
    minimum: 1,
    description: "Length of the streak in consecutive days."
  },
  reachedAt: {
    ...booksFields.timestamp,
    description: "Start of the day the streak first reached this length, in the time zone Books read in."
  }
};
var StreakRecordsStream = class extends BooksStream {
  name = "streakRecords";
  store = "readingHistory";
  primaryKey = ["days"];
  jsonSchema = {
    type: "object",
    description: "One source record per reading streak length Books recorded, with when it was first reached. Relationships name streams in this source, not physical destination tables.",
    properties: streakProperties,
    required: Object.keys(streakProperties)
  };
  rows(scan) {
    return scan.readingHistory.streaks;
  }
  record(streak) {
    return { days: streak.days, reachedAt: streak.reachedAt.toISOString() };
  }
};

// packages/sources/apple/books/dist/streams/reviews-stream.js
var { nullableInteger: nullableInteger10, nullableText: nullableText7, nullableTimestamp: nullableTimestamp8 } = booksFields;
var properties9 = {
  id: { ...booksFields.id, description: "Review identifier." },
  deleted: {
    ...booksFields.boolean,
    description: "Deleted, kept until the deletion syncs."
  },
  starRating: { ...nullableInteger10, description: "Stars given." },
  title: { ...nullableText7, description: "Review title." },
  body: { ...nullableText7, description: "Review text." },
  userId: {
    ...nullableText7,
    description: "Store user that wrote the review."
  },
  modifiedAt: {
    ...nullableTimestamp8,
    description: "When the review last changed."
  }
};
var ReviewsStream = class extends BooksStream {
  name = "reviews";
  store = "assetData";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One source record per store review the user wrote in Books, as Books syncs it. Relationships name streams in this source, not physical destination tables.",
    properties: properties9,
    required: Object.keys(properties9)
  };
  rows(scan) {
    return scan.assetData.reviews();
  }
  record(review) {
    return {
      id: review.id,
      deleted: review.deleted,
      starRating: review.starRating,
      title: review.title,
      body: review.body,
      userId: review.userId,
      modifiedAt: iso(review.modifiedAt)
    };
  }
};

// packages/sources/apple/books/dist/streams/themes-stream.js
var { nullableBoolean: nullableBoolean5, nullableNumber: nullableNumber3 } = booksFields;
var properties10 = {
  id: { ...booksFields.id, description: "Theme identifier." },
  hasCustomLayout: {
    ...nullableBoolean5,
    description: "Uses custom spacing rather than the theme default."
  },
  boldText: { ...nullableBoolean5, description: "Bold text." },
  justify: { ...nullableBoolean5, description: "Justified text." },
  multipleColumns: {
    ...nullableBoolean5,
    description: "Shows more than one column."
  },
  letterSpacing: { ...nullableNumber3, description: "Letter spacing." },
  lineHeight: { ...nullableNumber3, description: "Line height." },
  marginAdjustment: {
    ...nullableNumber3,
    description: "Margin adjustment."
  },
  wordSpacing: { ...nullableNumber3, description: "Word spacing." }
};
var ThemesStream = class extends BooksStream {
  name = "themes";
  store = "themes";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One source record per reading theme the user customized in Books (BookTheme). Per-language fonts are left out. Relationships name streams in this source, not physical destination tables.",
    properties: properties10,
    required: Object.keys(properties10)
  };
  rows(scan) {
    return scan.themes.themes();
  }
  record(theme) {
    return {
      id: theme.id,
      hasCustomLayout: theme.hasCustomLayout,
      boldText: theme.boldText,
      justify: theme.justify,
      multipleColumns: theme.multipleColumns,
      letterSpacing: theme.letterSpacing,
      lineHeight: theme.lineHeight,
      marginAdjustment: theme.marginAdjustment,
      wordSpacing: theme.wordSpacing
    };
  }
};

// packages/sources/apple/books/dist/apple-books-source.js
var readers = {
  libraryAssets: new LibraryAssetsStream(),
  collections: new CollectionsStream(),
  collectionMembers: new CollectionMembersStream(),
  bookFiles: new BookFilesStream(),
  annotations: new AnnotationsStream(),
  assetDetails: new AssetDetailsStream(),
  reviews: new ReviewsStream(),
  readingMonths: new ReadingMonthsStream(),
  readingDays: new ReadingDaysStream(),
  streakRecords: new StreakRecordsStream(),
  readingGoal: new ReadingGoalStream(),
  purchases: new PurchasesStream(),
  themes: new ThemesStream()
};
var catalog = new Catalog(Object.values(readers).map((reader) => reader.describe()));
var readersByName = new Map(Object.values(readers).map((reader) => [reader.name, reader]));
var readerOf = (stream) => {
  const reader = readersByName.get(stream.name);
  if (reader === void 0)
    throw new Error(`Apple Books has no stream ${stream.name}`);
  return reader;
};
var pollIntervalMs = 1e3;
var AppleBooksSource = class extends Source {
  identity;
  catalog = catalog;
  libraryAssets = readers.libraryAssets.describe();
  collections = readers.collections.describe();
  collectionMembers = readers.collectionMembers.describe();
  bookFiles = readers.bookFiles.describe();
  annotations = readers.annotations.describe();
  assetDetails = readers.assetDetails.describe();
  reviews = readers.reviews.describe();
  readingMonths = readers.readingMonths.describe();
  readingDays = readers.readingDays.describe();
  streakRecords = readers.streakRecords.describe();
  readingGoal = readers.readingGoal.describe();
  purchases = readers.purchases.describe();
  themes = readers.themes.describe();
  location;
  #books;
  constructor({ container = booksContainer, groupContainer = booksGroupContainer } = {}) {
    super();
    this.location = Object.freeze({ container, groupContainer });
    this.#books = new Books(this.location);
    this.identity = `apple-books:${container}:${groupContainer}`;
    Object.freeze(this);
  }
  open(streams) {
    return BooksScan.open(this.#books, new Set(streams.map((stream) => readerOf(stream).store)));
  }
  coverage(_stream) {
    return localAppleStoreCoverage;
  }
  // Each store the streams read reports its own changes. A book downloaded
  // from iCloud without a library change is picked up by the next change or
  // run.
  async *observe({ streams, signal }) {
    var _stack = [];
    try {
      if (signal.aborted)
        return;
      const versions = __using(_stack, new DisposableStack());
      const probes = new Map([...new Set(streams.map((stream) => readerOf(stream).store))].map((store) => [store, versions.use(this.#books.version(store))]));
      const seen = /* @__PURE__ */ new Map();
      for (const [store, probe] of probes)
        seen.set(store, await probe.current());
      yield streams;
      try {
        for await (const _2 of setInterval(pollIntervalMs, void 0, {
          signal
        })) {
          const changed = /* @__PURE__ */ new Set();
          for (const [store, probe] of probes) {
            const current = await probe.current();
            if (current === seen.get(store))
              continue;
            seen.set(store, current);
            changed.add(store);
          }
          if (changed.size > 0)
            yield streams.filter((stream) => changed.has(readerOf(stream).store));
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
    var _stack = [];
    try {
      const { stream } = configuration;
      const reader = readerOf(stream);
      const records = await reader.read(scan);
      const messages = configuration.syncMode === "incremental" ? diffSnapshot(stream, records, state) : records.map((data) => ({ stream: stream.name, data }));
      if (configuration.fileReads.length === 0) {
        yield* messages;
        return;
      }
      const staging = __using(_stack, await mkdtempDisposable(join4(tmpdir(), "elt-books-")), true);
      for await (const message of messages) {
        if ("type" in message) {
          yield message;
          continue;
        }
        const file = await reader.file(message.data, scan, staging.path);
        yield { ...message, file };
        if (file?.startsWith(staging.path))
          await rm(file, { force: true });
      }
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      var _promise = __callDispose(_stack, _error, _hasError);
      _promise && await _promise;
    }
  }
};

// packages/connectors/apple/books/dist/books-connector.js
var BooksConnector = class extends AppleConnector {
  datedBy = null;
  fullDiskAccess = true;
  // Books' collections are built-in lists; everything is imported.
  choices = [];
  // Collections live in the library store every Books import reads.
  probe = "collections";
  unscoped = [];
  storeCopies = [];
  access() {
    return "Books does not need to be open. Books stored only in iCloud are listed without their files; open them in Books to download them.";
  }
  source() {
    return new AppleBooksSource();
  }
};
export {
  BooksConnector as default
};
