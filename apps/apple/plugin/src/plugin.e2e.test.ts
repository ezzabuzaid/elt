import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempDisposable, open, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ElicitRequestSchema,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// NoteStore.sqlite's tables as macOS 26.6.2 creates them (schema only, no
// data), in WAL mode like the real store.
const noteStoreSchema = `PRAGMA journal_mode = WAL;
CREATE TABLE ZICCLOUDSYNCINGOBJECT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCRYPTOITERATIONCOUNT INTEGER, ZHASMISSINGKEYCHAINITEM INTEGER, ZISPASSWORDPROTECTED INTEGER, ZISRECOVERINGFROMTRASH INTEGER, ZISSHAREDIRTY INTEGER, ZMARKEDFORDELETION INTEGER, ZMINIMUMSUPPORTEDNOTESVERSION INTEGER, ZNEEDSINITIALFETCHFROMCLOUD INTEGER, ZNEEDSTOBEFETCHEDFROMCLOUD INTEGER, ZNEEDSTOFETCHUSERSPECIFICRECORDASSETS INTEGER, ZNEEDSTOSAVEUSERSPECIFICRECORD INTEGER, ZNEEDSTOUPDATEUSERSPECIFICRECORDREFERENCEACTIONS INTEGER, ZCLOUDSTATE INTEGER, ZINVITATION INTEGER, ZLOCKEDNOTESMODE INTEGER, ZSUPPORTSV1NEO INTEGER, ZACCOUNT INTEGER, ZCHECKEDFORLOCATION INTEGER, ZDIDRUNPAPERFORMDETECTION INTEGER, ZFILESIZE INTEGER, ZHANDWRITINGSUMMARYVERSION INTEGER, ZHASMARKUPDATA INTEGER, ZHASPAPERFORM INTEGER, ZIMAGECLASSIFICATIONSUMMARYVERSION INTEGER, ZIMAGEFILTERTYPE INTEGER, ZNEEDSINITIALRELATIONSHIPSETUP INTEGER, ZNEEDSTRANSCRIPTION INTEGER, ZOCRSUMMARYVERSION INTEGER, ZORIENTATION INTEGER, ZSECTION INTEGER, ZURLEXPIRED INTEGER, ZACCOUNT1 INTEGER, ZLOCATION INTEGER, ZMEDIA INTEGER, ZNOTE INTEGER, ZNOTEUSINGTITLEFORNOTETITLE INTEGER, ZPARENTATTACHMENT INTEGER, ZAPPEARANCETYPE INTEGER, ZSCALEWHENDRAWING INTEGER, ZVERSION INTEGER, ZVERSIONOUTOFDATE INTEGER, ZATTACHMENT INTEGER, ZSTATE INTEGER, ZACCOUNT2 INTEGER, ZACCOUNT3 INTEGER, ZMENTIONNOTIFICATIONATTEMPTCOUNT INTEGER, ZMENTIONNOTIFICATIONSTATE INTEGER, ZACCOUNT4 INTEGER, ZNOTE1 INTEGER, ZPARENTATTACHMENT1 INTEGER, ZTYPE INTEGER, ZACCOUNT5 INTEGER, ZACCOUNT6 INTEGER, ZATTACHMENT1 INTEGER, ZATTACHMENTVIEWTYPE INTEGER, ZHASCHECKLIST INTEGER, ZHASCHECKLISTINPROGRESS INTEGER, ZHASEMPHASIS INTEGER, ZHASSYSTEMTEXTATTACHMENTS INTEGER, ZISPINNED INTEGER, ZISSYSTEMPAPER INTEGER, ZLEGACYNOTEWASPLAINTEXT INTEGER, ZNOTEHASCHANGES INTEGER, ZPAPERSTYLETYPE INTEGER, ZPREFERREDBACKGROUNDTYPE INTEGER, ZACCOUNT7 INTEGER, ZFOLDER INTEGER, ZNOTEDATA INTEGER, ZTITLESOURCEATTACHMENT INTEGER, ZDATEHEADERSTYPE INTEGER, ZSORTORDER INTEGER, ZOWNER INTEGER, ZACCOUNTTYPE INTEGER, ZDIDCHOOSETOMIGRATE INTEGER, ZDIDFINISHMIGRATION INTEGER, ZDIDMIGRATEONMAC INTEGER, ZSERVERSIDEUPDATETASKFAILURECOUNT INTEGER, ZSTOREDATASEPARATELY INTEGER, ZACCOUNTDATA INTEGER, ZCUSTOMNOTESORTTYPEVALUE INTEGER, ZFOLDERTYPE INTEGER, ZIMPORTEDFROMLEGACY INTEGER, ZACCOUNT8 INTEGER, ZPARENT INTEGER, ZCREATIONDATE TIMESTAMP, ZCROPPINGQUADBOTTOMLEFTX FLOAT, ZCROPPINGQUADBOTTOMLEFTY FLOAT, ZCROPPINGQUADBOTTOMRIGHTX FLOAT, ZCROPPINGQUADBOTTOMRIGHTY FLOAT, ZCROPPINGQUADTOPLEFTX FLOAT, ZCROPPINGQUADTOPLEFTY FLOAT, ZCROPPINGQUADTOPRIGHTX FLOAT, ZCROPPINGQUADTOPRIGHTY FLOAT, ZDURATION FLOAT, ZMODIFICATIONDATE TIMESTAMP, ZORIGINX FLOAT, ZORIGINY FLOAT, ZPREVIEWUPDATEDATE TIMESTAMP, ZSIZEHEIGHT FLOAT, ZSIZEWIDTH FLOAT, ZHEIGHT FLOAT, ZMODIFIEDDATE TIMESTAMP, ZSCALE FLOAT, ZWIDTH FLOAT, ZSTATEMODIFICATIONDATE TIMESTAMP, ZCREATIONDATE1 TIMESTAMP, ZCREATIONDATE2 TIMESTAMP, ZMODIFICATIONDATEATIMPORT TIMESTAMP, ZCREATIONDATE3 TIMESTAMP, ZFOLDERMODIFICATIONDATE TIMESTAMP, ZLASTACTIVITYRECENTUPDATESVIEWEDDATE TIMESTAMP, ZLASTACTIVITYSUMMARYVIEWEDDATE TIMESTAMP, ZLASTATTRIBUTIONSVIEWEDDATE TIMESTAMP, ZLASTNOTIFIEDDATE TIMESTAMP, ZLASTOPENEDDATE TIMESTAMP, ZLASTVIEWEDMODIFICATIONDATE TIMESTAMP, ZLEGACYMODIFICATIONDATEATIMPORT TIMESTAMP, ZMODIFICATIONDATE1 TIMESTAMP, ZLASTSYNCDATE TIMESTAMP, ZCUSTOMNOTESORTTYPEMODIFICATIONDATE TIMESTAMP, ZDATEFORLASTTITLEMODIFICATION TIMESTAMP, ZPARENTMODIFICATIONDATE TIMESTAMP, ZIDENTIFIER VARCHAR, ZPASSWORDHINT VARCHAR, ZZONEOWNERNAME VARCHAR, ZADDITIONALINDEXABLETEXT VARCHAR, ZFALLBACKIMAGEGENERATION VARCHAR, ZFALLBACKPDFGENERATION VARCHAR, ZFALLBACKSUBTITLEIOS VARCHAR, ZFALLBACKSUBTITLEMAC VARCHAR, ZFALLBACKTITLE VARCHAR, ZHANDWRITINGSUMMARY VARCHAR, ZIMAGECLASSIFICATIONSUMMARY VARCHAR, ZOCRSUMMARY VARCHAR, ZPAPERBUNDLEGENERATION VARCHAR, ZREMOTEFILEURLSTRING VARCHAR, ZSUMMARY VARCHAR, ZTITLE VARCHAR, ZTYPEUTI VARCHAR, ZURLSTRING VARCHAR, ZUSERTITLE VARCHAR, ZGENERATION VARCHAR, ZDEVICEIDENTIFIER VARCHAR, ZDISPLAYTEXT VARCHAR, ZSTANDARDIZEDCONTENT VARCHAR, ZALTTEXT VARCHAR, ZTOKENCONTENTIDENTIFIER VARCHAR, ZTYPEUTI1 VARCHAR, ZCONTENTHASHATIMPORT VARCHAR, ZFILENAME VARCHAR, ZGENERATION1 VARCHAR, ZHOSTAPPLICATIONIDENTIFIER VARCHAR, ZLEGACYCONTENTHASHATIMPORT VARCHAR, ZLEGACYIMPORTDEVICEIDENTIFIER VARCHAR, ZLEGACYMANAGEDOBJECTIDURIREPRESENTATION VARCHAR, ZSELECTEDINKCOLORSTRING VARCHAR, ZSELECTEDINKIDENTIFIER VARCHAR, ZSNIPPET VARCHAR, ZTHUMBNAILATTACHMENTIDENTIFIER VARCHAR, ZTITLE1 VARCHAR, ZWIDGETSNIPPET VARCHAR, ZACCOUNTNAMEFORACCOUNTLISTSORTING VARCHAR, ZNESTEDTITLEFORSORTING VARCHAR, ZNAME VARCHAR, ZSERVERSIDEUPDATETASKLASTATTEMPTEDBUILD VARCHAR, ZSERVERSIDEUPDATETASKLASTATTEMPTEDVERSION VARCHAR, ZSERVERSIDEUPDATETASKLASTCOMPLETEDBUILD VARCHAR, ZSERVERSIDEUPDATETASKLASTCOMPLETEDVERSION VARCHAR, ZUSERRECORDNAME VARCHAR, ZSMARTFOLDERQUERYJSON VARCHAR, ZTITLE2 VARCHAR, ZATTRIBUTEDSNIPPET BLOB, ZATTRIBUTEDTITLE BLOB, ZREPLICAIDTOBUNDLEIDENTIFIER BLOB, ZACTIVITYEVENTSDATA BLOB, ZASSETCRYPTOINITIALIZATIONVECTOR BLOB, ZASSETCRYPTOTAG BLOB, ZCRYPTOINITIALIZATIONVECTOR BLOB, ZCRYPTOSALT BLOB, ZCRYPTOTAG BLOB, ZCRYPTOWRAPPEDKEY BLOB, ZENCRYPTEDVALUESJSON BLOB, ZREPLICAIDTONOTESVERSIONDATA BLOB, ZSERVERRECORDDATA BLOB, ZSERVERSHAREDATA BLOB, ZUNAPPLIEDENCRYPTEDRECORDDATA BLOB, ZUSERSPECIFICSERVERRECORDDATA BLOB, ZCRYPTOPASSPHRASEVERIFIER BLOB, ZMERGEABLEDATA BLOB, ZFALLBACKIMAGECRYPTOINITIALIZATIONVECTOR BLOB, ZFALLBACKIMAGECRYPTOTAG BLOB, ZFALLBACKPDFCRYPTOINITIALIZATIONVECTOR BLOB, ZFALLBACKPDFCRYPTOTAG BLOB, ZLINKPRESENTATIONARCHIVEDMETADATA BLOB, ZMARKUPMODELDATA BLOB, ZMERGEABLEDATA1 BLOB, ZMERGEABLEPREFERREDVIEWSIZE BLOB, ZMETADATADATA BLOB, ZSYNAPSEDATA BLOB, ZTEMPORARYTRANSCRIPTDATA BLOB, ZCRYPTOMETADATAINITIALIZATIONVECTOR BLOB, ZCRYPTOMETADATATAG BLOB, ZENCRYPTEDMETADATA BLOB, ZMETADATA BLOB, ZLASTNOTIFIEDTIMESTAMPDATA BLOB, ZLASTVIEWEDTIMESTAMPDATA BLOB, ZOUTLINESTATEDATA BLOB, ZREPLICAIDTOUSERIDDICTDATA BLOB, ZCRYPTOVERIFIER BLOB, ZSERVERSIDEUPDATETASKCONTINUATIONTOKEN BLOB, ZMERGEABLEDATA2 BLOB );
CREATE TABLE ZICLOCATION ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZPLACEUPDATED INTEGER, ZATTACHMENT INTEGER, ZLATITUDE FLOAT, ZLONGITUDE FLOAT, ZPLACEMARKDATA BLOB );
CREATE TABLE ZICNOTEDATA ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZNOTE INTEGER, ZCRYPTOINITIALIZATIONVECTOR BLOB, ZCRYPTOTAG BLOB, ZDATA BLOB );
CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);`;

// Entities as the real store numbers them in Z_PRIMARYKEY.
const noteEntities = {
  ICAccount: 14,
  ICAttachment: 5,
  ICFolder: 15,
  ICInlineAttachment: 9,
  ICMedia: 11,
  ICNote: 12,
} as const;

// A 2×2 table (a1 b1 / a2 b2) as Notes saved it: a gzipped CRDT document.
const noteTable = Buffer.from(
  'H4sIAAAAAAAAE7VVW2jTYBRusq7Lss7F6DaNMjHeRsZKjXhBJzhao9OuStt5HdM0/Z2pWTLTdE4fFCuigogXHCoiMkHBPeh8UJCp+OCD0yGoTIYPvil4x9uDL3rSyzRLQcH5k/TkfOf7z5/v/On5CQf9sIxwUA7mXhnpIp3wiDGr40GCYjjCQc9kp3uzozbPT24wLgKjcS8GtgBsAdhCsARYF9hSxk2Smdzg4UxtvIbAmFkETk9jp/pCETGqIJ+mJNtUv6wjyZA1NYC2GBEtJLduNZhHWAp7gJHdGLmLDNCuD3f64GKodELzzdO2GksjGCA4k7bVOFNBEhD7AaMMeMPPHE5g5k2PB4nUq6/rAq/PNuo3jpV/3OsfXAQoRlPz0eu+/m5h/alU/3Nx4MoyejpJkbjXlOVksoVKI0WAuHLIb6xCG6sohzDuOEngUBwnjY/wcItXYPGc/7sSh1eWxluq/JcuDBh6Z/zW+UwlBrw14eYvQu0VrPOtwQ1qWY0kKCq2aHQDUjKiEiaLtLHceStRaPFcFq/I4hHMTD6TvwSyjbHkLwZk7HD+HA9mecssPPPDpIZ5zaENNB6d/U+1nAAf9PgJ2ApqbXddDy8JVfs98X3XvcsfZ7Pzo5O95+3g0Lt+4XtKPrN4W2nXS4tG2qZxnFWjOEoatwvuz5tahNS1y8/uLMB71Wz2UdJ4/dzd3qlNS8jbGzuOLG85HWcJOYZUQzZ2shWSnq9hsM4EUrawLkkPaTsSbHFTU4O/QY2hTrZY0jPcBFsiIUXJOlylpLV5xPZ2BXl8IX/EEwwHk21RpOcJhA1dVlu5clvAXIWrGAFDR0uCw1Xb8BBqlRMG0huTiiGvEZUkCiAxYXDT/oJpWx2W0RHiJuaFg1rMPiMY9ouGmB9G3OxfsKoZKOFp8PkULRkL71QlUL8qGodK10OxO2AblnbAdvyuMDdFAD3mjDBSMhsTNszkrJ0ZidQnY7IWQpKmx8zy1vyZ4xF0sbXNXHpGPnJEF9WEpMvtRhhlaJUjadnjxh6A+WaAp45i9w9Nqgt8O80Unjt4YaiZp/pmvXfseCKUX2vcPP8ANecrbzszeGpy7Fst39X47HLlmynvT/ac4G0nCE99unk1dWOgfs/xFyW7I3Vje3lbx+WpQGioap7csO9i9FX53M9Pf/C2/rtwMsmQtrekcfjvQCf/CfJmFaHRBwAA',
  'base64',
);

// Protocol Buffers encoding for note bodies: varints and length-delimited
// fields are all a topotext.String needs.
const protobuf = {
  varint(value: number): number[] {
    const bytes: number[] = [];
    let rest = value;
    while (rest > 0x7f) {
      bytes.push((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    bytes.push(rest);
    return bytes;
  },
  number(field: number, value: number): number[] {
    return [...protobuf.varint(field << 3), ...protobuf.varint(value)];
  },
  bytes(field: number, value: Uint8Array | string | number[]): number[] {
    const bytes =
      typeof value === 'string' ? [...Buffer.from(value, 'utf8')] : [...value];
    return [
      ...protobuf.varint((field << 3) | 2),
      ...protobuf.varint(bytes.length),
      ...bytes,
    ];
  },
};

type NoteRun = {
  text: string;
  style?: number;
  todo?: { id: string; done: boolean };
  bold?: boolean;
  link?: string;
  attachment?: { id: string; type: string };
};

// A note body as Notes stores it: versioned_document.Document > Version >
// topotext.String { string, attribute runs }, gzipped.
const noteBody = (runs: NoteRun[]) => {
  const text = runs.map((run) => run.text).join('');
  const string = [
    ...protobuf.bytes(2, text),
    ...runs.flatMap((run) =>
      protobuf.bytes(5, [
        ...protobuf.number(1, run.text.length),
        ...(run.style === undefined && run.todo === undefined
          ? []
          : protobuf.bytes(2, [
              ...(run.style === undefined ? [] : protobuf.number(1, run.style)),
              ...(run.todo === undefined
                ? []
                : protobuf.bytes(5, [
                    ...protobuf.bytes(1, Buffer.from(run.todo.id, 'hex')),
                    ...protobuf.number(2, run.todo.done ? 1 : 0),
                  ])),
            ])),
        ...(run.bold ? protobuf.number(5, 1) : []),
        ...(run.link === undefined ? [] : protobuf.bytes(9, run.link)),
        ...(run.attachment === undefined
          ? []
          : protobuf.bytes(12, [
              ...protobuf.bytes(1, run.attachment.id),
              ...protobuf.bytes(2, run.attachment.type),
            ])),
      ]),
    ),
  ];
  return gzipSync(
    Uint8Array.from(
      protobuf.bytes(2, [
        ...protobuf.number(1, 0),
        ...protobuf.bytes(3, string),
      ]),
    ),
  );
};

// Core Data dates: seconds since 2001-01-01.
const coreDataSeconds = (iso: string) =>
  (Date.parse(iso) - Date.UTC(2001, 0, 1)) / 1000;

const richNote = [
  { text: 'Groceries\n', style: 0, bold: true },
  { text: 'Milk\n', style: 103, todo: { id: 'aa'.repeat(16), done: true } },
  { text: 'Eggs\n', style: 103, todo: { id: 'bb'.repeat(16), done: false } },
  { text: 'Buy ' },
  { text: 'fresh', bold: true },
  { text: '\nsee ' },
  { text: 'site', link: 'https://example.com/list' },
  { text: '\n' },
  { text: '￼', attachment: { id: 'ATT-FILE', type: 'public.plain-text' } },
  { text: '\n' },
  {
    text: '￼',
    attachment: { id: 'ATT-TABLE', type: 'com.apple.notes.table' },
  },
  { text: '\ntag ' },
  {
    text: '￼',
    attachment: {
      id: 'INLINE-TAG',
      type: 'com.apple.notes.inlinetextattachment.hashtag',
    },
  },
  { text: '\nlink ' },
  {
    text: '\ufffc',
    attachment: {
      id: 'INLINE-LINK',
      type: 'com.apple.notes.inlinetextattachment.link',
    },
  },
  { text: '\n' },
];

// A store with a formatted note (checklist, link, file, table, tag), a
// locked note, a note in Recently Deleted, a cloud placeholder and a row
// Notes marked for deletion. The file attachment's bytes sit where Notes
// keeps media; the photo's do not, as when iCloud has not downloaded it.
const noteStoreFixture = async (directory: string) => {
  const path = join(directory, 'NoteStore.sqlite');
  const media = join(
    directory,
    'Accounts',
    'ACCOUNT-1',
    'Media',
    'MEDIA-FILE',
    '1_GEN',
  );
  mkdirSync(media, { recursive: true });
  await writeFile(join(media, 'list.txt'), 'attached words');
  using database = new DatabaseSync(path);
  database.exec(noteStoreSchema);
  const entity = database.prepare(
    'INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME) VALUES (?, ?)',
  );
  for (const [name, id] of Object.entries(noteEntities)) entity.run(id, name);
  const created = coreDataSeconds('2025-01-02T03:04:05.006Z');
  const modified = coreDataSeconds('2025-02-03T04:05:06.007Z');
  database.exec(`
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZNAME, ZACCOUNTTYPE) VALUES (1, 14, 'ACCOUNT-1', 'iCloud', 1);
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE2, ZACCOUNT8, ZFOLDERTYPE, ZPARENT) VALUES
      (2, 15, 'FOLDER-NOTES', 'Notes', 1, 0, NULL),
      (3, 15, 'FOLDER-TRASH', 'Recently Deleted', 1, 1, NULL),
      (4, 15, 'FOLDER-CHILD', 'Child', 1, 0, 2);
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE1, ZFOLDER, ZACCOUNT7, ZNOTEDATA, ZCREATIONDATE3, ZMODIFICATIONDATE1, ZISPINNED, ZISPASSWORDPROTECTED, ZHASCHECKLIST, ZHASCHECKLISTINPROGRESS) VALUES
      (5, 12, 'NOTE-RICH', 'Groceries', 2, 1, 1, ${created}, ${modified}, 1, 0, 1, 1),
      (6, 12, 'NOTE-LOCKED', 'Secret', 2, 1, 2, ${created}, ${modified}, 0, 1, 0, 0),
      (7, 12, 'NOTE-PLACEHOLDER', NULL, NULL, 1, 3, NULL, NULL, 0, 0, 0, 0),
      (8, 12, 'NOTE-TRASHED', 'Old', 3, 1, 4, ${created}, ${modified}, 0, 0, 0, 0);
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZNOTE, ZACCOUNT1, ZMEDIA, ZTYPEUTI, ZFILESIZE, ZCREATIONDATE, ZMODIFICATIONDATE, ZOCRSUMMARY, ZMARKEDFORDELETION) VALUES
      (9, 5, 'ATT-FILE', 5, 1, 10, 'public.plain-text', 14, ${created}, ${modified}, NULL, 0),
      (11, 5, 'ATT-TABLE', 5, 1, NULL, 'com.apple.notes.table', 0, ${created}, ${modified}, NULL, 0),
      (12, 5, 'ATT-PHOTO', 5, 1, 13, 'public.jpeg', 2048, ${created}, ${modified}, 'photo words', 0),
      (14, 5, 'ATT-LOCKED', 6, 1, NULL, 'public.jpeg', 10, ${created}, ${modified}, 'secret words', 0),
      (16, 5, 'ATT-PURGED', 5, 1, NULL, 'public.jpeg', 10, ${created}, ${modified}, NULL, 1);
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZFILENAME, ZGENERATION1, ZACCOUNT6, ZATTACHMENT1) VALUES
      (10, 11, 'MEDIA-FILE', 'list.txt', '1_GEN', 1, 9),
      (13, 11, 'MEDIA-PHOTO', 'photo.jpg', '1_GEN', 1, 12);
    INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZNOTE1, ZTYPEUTI1, ZALTTEXT, ZTOKENCONTENTIDENTIFIER, ZCREATIONDATE2) VALUES
      (15, 9, 'INLINE-TAG', 5, 'com.apple.notes.inlinetextattachment.hashtag', '#food', 'FOOD', ${created}),
      (17, 9, 'INLINE-LINK', 5, 'com.apple.notes.inlinetextattachment.link', 'Old', 'applenotes:note/note-trashed', ${created});
    INSERT INTO ZICLOCATION (ZATTACHMENT, ZLATITUDE, ZLONGITUDE) VALUES (12, 52.52, 13.405);
  `);
  database
    .prepare(
      'UPDATE ZICCLOUDSYNCINGOBJECT SET ZMERGEABLEDATA1 = ? WHERE Z_PK = 11',
    )
    .run(noteTable);
  const data = database.prepare(
    'INSERT INTO ZICNOTEDATA (Z_PK, ZNOTE, ZDATA) VALUES (?, ?, ?)',
  );
  data.run(1, 5, noteBody(richNote));
  data.run(2, 6, Uint8Array.from([1, 2, 3]));
  data.run(3, 7, noteBody([{ text: 'not downloaded\n' }]));
  data.run(4, 8, noteBody([{ text: 'Old\nthrown away\n' }]));
  return path;
};

const root = resolve(import.meta.dirname, '../../../..');

// Where a server under test finds its HOME: as short as a real /Users/<name>,
// since the plugin keeps its store under HOME and the socket its servers meet
// on must fit in 103 bytes, which the macOS temporary folder is too deep for.
const homes = '/tmp';

// A selected_connectors row with its import's latest pass from sync_status, as
// the query-apple skill reads them.
type SelectedConnector = {
  connector: string;
  scope: string;
  include_attachments: 0 | 1;
  database: string;
  connection_error: string | null;
  sync:
    | {
        latest_attempt_id: number;
        status: string;
        error: string | null;
        last_successful_sync_at: string | null;
      }
    | undefined;
};

// The query-apple skill's read command: everything as arguments, since the
// read-only sandbox refuses the temporary file a heredoc needs.
function read(database: string, sql: string, ...commands: string[]) {
  const { stdout, stderr, status } = spawnSync(
    '/usr/bin/sqlite3',
    [
      '-readonly',
      '-json',
      ...['.timeout 30000', 'PRAGMA temp_store = MEMORY', ...commands].flatMap(
        (command) => ['-cmd', command],
      ),
      database,
      sql,
    ],
    { encoding: 'utf8' },
  );
  return { rows: JSON.parse(stdout || '[]'), stderr, status };
}

test(
  'the committed Apple plugin installs from the repo marketplace, sets up through Codex bundled Node, imports in the background and serves it to the skill read command',
  {
    timeout: 180_000,
  },
  async (t) => {
    await using scratch = await mkdtempDisposable(join(homes, 'apple-e2e-'));
    const marketplace = JSON.parse(
      readFileSync(join(root, '.agents/plugins/marketplace.json'), 'utf8'),
    );
    const [entry] = marketplace.plugins;
    assert.equal(entry.name, 'apple');
    // Codex copies the plugin directory into its cache and runs it from there.
    const plugin = join(scratch.path, 'plugin');
    cpSync(join(root, entry.source.path), plugin, { recursive: true });
    for (const path of readdirSync(plugin, {
      recursive: true,
      encoding: 'utf8',
    }))
      assert.equal(lstatSync(join(plugin, path)).isSymbolicLink(), false, path);
    const manifest = JSON.parse(
      readFileSync(join(plugin, '.codex-plugin/plugin.json'), 'utf8'),
    );
    assert.equal(manifest.name, entry.name);
    for (const path of [
      manifest.extensions['com.openai'].onboardingSkill,
      manifest.interface.logo,
      manifest.interface.composerIcon,
      './skills/query-apple/SKILL.md',
    ])
      assert.ok(existsSync(join(plugin, path)), path);
    const {
      mcpServers: { apple },
    } = JSON.parse(readFileSync(join(plugin, manifest.mcpServers), 'utf8'));
    accessSync(join(plugin, apple.command), constants.X_OK);
    const runtime =
      process.env.CODEX_MCP_NODE_PATH ??
      join(
        homedir(),
        '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node',
      );
    assert.ok(
      existsSync(runtime),
      'Open the ChatGPT desktop app to install the Codex bundled runtime',
    );
    // The user's Notes, where the server looks for them under this HOME.
    const noteStore = await noteStoreFixture(
      join(scratch.path, 'Library/Group Containers/group.com.apple.notes'),
    );
    const retitle = (title: string) => {
      using database = new DatabaseSync(noteStore);
      database
        .prepare(
          "UPDATE ZICCLOUDSYNCINGOBJECT SET ZTITLE1 = ? WHERE ZIDENTIFIER = 'NOTE-RICH'",
        )
        .run(title);
    };
    let diagnostics = '';
    const launch = () => {
      const transport = new StdioClientTransport({
        command: join(plugin, apple.command),
        args: apple.args,
        cwd: join(plugin, apple.cwd),
        env: { HOME: scratch.path, CODEX_MCP_NODE_PATH: runtime, PATH: '' },
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (data) => {
        diagnostics += String(data);
      });
      return transport;
    };
    const connect = async (client: Client) => {
      const transport = launch();
      await client.connect(transport, { signal: t.signal, timeout: 5_000 });
      return transport;
    };
    const call = (
      client: Client,
      name: string,
      args?: Record<string, unknown>,
    ) =>
      client.callTool({ name, arguments: args }, undefined, {
        signal: t.signal,
        timeout: 90_000,
      });
    const invoke = async (
      client: Client,
      name: string,
      args?: Record<string, unknown>,
    ) => {
      const result = await call(client, name, args);
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.ok(Array.isArray(result.content));
      const block = result.content[0];
      assert.equal(block?.type, 'text');
      return JSON.parse(block.text);
    };
    // What the plugin's hooks add to a chat's context.
    const context = async (
      client: Client,
      event: 'SessionStart' | 'UserPromptSubmit',
    ) => {
      const result = await call(client, 'apple_context', { event });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.ok(Array.isArray(result.content));
      return result.content.map((block) => block.text).join('\n');
    };
    // The skill's entry point: the selection, with no tool call.
    const settingsFile = join(
      scratch.path,
      'Library/Application Support/Context Compiler/Apple/settings.sqlite',
    );
    const selected = (): SelectedConnector[] =>
      read(
        settingsFile,
        'SELECT connector, scope, include_attachments, database, connection_error FROM selected_connectors',
      ).rows.map((row: Omit<SelectedConnector, 'sync'>) => {
        const database = join(dirname(settingsFile), row.database);
        return {
          ...row,
          database,
          sync: read(
            database,
            'SELECT latest_attempt_id, status, error, last_successful_sync_at FROM sync_status',
          ).rows[0],
        };
      });
    // Waits until the selected connectors reach the state done looks for.
    const settled = async (
      what: string,
      done: (connectors: SelectedConnector[]) => boolean,
    ): Promise<SelectedConnector[]> => {
      for (let attempt = 0; attempt < 60; attempt++) {
        const connectors = selected();
        if (done(connectors)) return connectors;
        await sleep(500);
      }
      assert.fail(`The import never ${what}`);
    };
    const notesOf = (connectors: SelectedConnector[]) =>
      connectors.find(({ connector }) => connector === 'notes');
    const imported = async (title: string) => {
      const notes = notesOf(
        await settled(`showed ${title}`, (connectors) => {
          const notes = notesOf(connectors);
          return (
            notes?.sync?.status === 'succeeded' &&
            read(
              notes.database,
              'SELECT title FROM notes WHERE title = @title',
              `.parameter set @title "'${title}'"`,
            ).rows.length === 1
          );
        }),
      );
      assert.ok(notes);
      return notes;
    };

    const client = new Client(
      { name: 'apple-e2e', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } } },
    );
    const forms: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
      forms.push(params.message);
      // A person reads the form for longer than the SDK's 60 s request default.
      await sleep(61_000);
      return { action: 'accept', content: { connectors: ['notes'] } };
    });
    const other = new Client({ name: 'another-chat', version: '1.0.0' });
    const transport = await connect(client);
    const otherTransport = await connect(other);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        'apple_configure',
        'apple_connector_choices',
        'apple_connector_update',
        'apple_connector_watch',
        'apple_connectors',
        'apple_context',
        'apple_monitor_add',
        'apple_monitor_remove',
        'apple_monitors',
        'apple_open_full_disk_access',
        'apple_options',
        'apple_page',
        'apple_setup',
        'apple_sync',
        'apple_transcription',
        'apple_transcription_update',
      ]);
      const metaOf = (name: string) =>
        tools.find((tool) => tool.name === name)?._meta;
      // Only the hooks and the Apple page call these; Codex keeps them from
      // the model.
      for (const name of [
        'apple_context',
        'apple_connectors',
        'apple_connector_choices',
        'apple_connector_update',
        'apple_connector_watch',
        'apple_sync',
        'apple_transcription',
        'apple_transcription_update',
        'apple_open_full_disk_access',
        'apple_monitors',
        'apple_monitor_remove',
      ])
        assert.deepEqual(metaOf(name), { ui: { visibility: ['app'] } }, name);
      // A chat's agent adds the monitor it wrote, so the model sees this one.
      assert.equal(metaOf('apple_monitor_add'), undefined);
      // ChatGPT lists the Apple page in its sidebar, finds it in Settings
      // search by its connectors' names, and opens it from the page's own
      // resource.
      const pageMeta = metaOf('apple_page');
      assert.deepEqual(pageMeta?.ui, {
        resourceUri: 'ui://apple/page.html',
        visibility: ['app'],
      });
      // ChatGPT leaves out its own title row above the page, which draws its
      // own. @openai/mcp-extensions 0.1.0's schema predates header, so the
      // test reads the entrypoints with its own.
      const {
        entrypoints: [global, settings],
      } = z
        .strictObject({
          entrypoints: z.tuple([
            z.strictObject({
              type: z.literal('global'),
              header: z.strictObject({ enabled: z.boolean() }),
            }),
            z.strictObject({
              type: z.literal('settings'),
              searchTerms: z.array(z.string()),
            }),
          ]),
        })
        .parse(pageMeta?.['openai/ui']);
      assert.equal(global.header.enabled, false);
      for (const term of ['connectors', 'Notes', 'Mail', 'Calendar'])
        assert.ok(settings.searchTerms.includes(term), term);
      const { contents: pages } = await client.readResource({
        uri: 'ui://apple/page.html',
      });
      assert.equal(pages.length, 1);
      const [pageResource] = pages;
      assert.equal(pageResource?.mimeType, 'text/html;profile=mcp-app');
      assert.match(
        String(pageResource && 'text' in pageResource ? pageResource.text : ''),
        /^<!doctype html>[\s\S]*<div id="root"><\/div>\s*<script type="module">[\s\S]{10000,}<\/script>\s*<\/body>/,
      );
      for (const name of [
        'apple_connectors',
        'apple_connector_choices',
        'apple_connector_update',
        'apple_connector_watch',
        'apple_sync',
        'apple_transcription',
        'apple_transcription_update',
        'apple_open_full_disk_access',
        'apple_monitors',
        'apple_monitor_remove',
      ])
        assert.ok(
          pageResource &&
            'text' in pageResource &&
            pageResource.text.includes(`"${name}"`),
          name,
        );
      // Codex shows these instructions with the tools.
      assert.match(String(client.getInstructions()), /\$query-apple/);
      // The server names the installed version.
      assert.equal(client.getServerVersion()?.version, manifest.version);
      // ChatGPT drops a page's Settings search terms while the server also
      // has a native Settings section, so Apple has none.
      assert.equal(
        client.getServerCapabilities()?.experimental?.['openai/settings'],
        undefined,
      );
      assert.deepEqual(selected(), []);
      // The chat can send the user to the Apple page by its deep link.
      const started = await context(client, 'SessionStart');
      assert.match(started, /no connectors are set up\. Use \$setup-apple/);
      assert.ok(
        started.includes('codex://plugins/apple/app/apple_page'),
        started,
      );
      assert.equal(await context(client, 'UserPromptSubmit'), '');
      assert.deepEqual((await call(other, 'apple_setup')).content, [
        {
          type: 'text',
          text: 'This host cannot show forms. Set up with apple_options, then apple_configure.',
        },
      ]);

      // Setup returns once the answers are saved; the import runs apart from it.
      const setUp = await invoke(client, 'apple_setup');
      // One form: the connectors. Notes is imported in full without further
      // questions.
      assert.equal(forms.length, 1);
      assert.match(forms[0] ?? '', /Choose the Apple connectors/);
      assert.deepEqual(setUp.unavailable, []);
      assert.deepEqual(
        setUp.connectors.map(
          ({ connector }: { connector: string }) => connector,
        ),
        ['notes'],
      );
      const synced = await imported('Groceries');
      // The next prompt carries the changed status: where Notes is imported.
      const status = await context(client, 'UserPromptSubmit');
      assert.match(
        status,
        /^- Notes: synced at \d{4}-\d\d-\d\dT[\d:.]+Z; data as of \d{4}-\d\d-\d\dT[\d:.]+Z\. Database: notes\/[0-9a-f]{16}\/data\.sqlite$/m,
      );
      assert.ok(
        status.includes(
          join(
            scratch.path,
            'Library/Application Support/Context Compiler/Apple',
          ),
        ),
      );
      assert.equal(await context(client, 'UserPromptSubmit'), '');
      // The file the skill reads tells what it holds and how fresh it is.
      assert.deepEqual(
        read(
          synced.database,
          "SELECT name FROM catalog WHERE kind = 'view' AND name IN ('notes', 'stream_status') ORDER BY name",
        ).rows,
        [{ name: 'notes' }, { name: 'stream_status' }],
      );
      assert.deepEqual(
        read(
          synced.database,
          "SELECT status FROM stream_status WHERE stream = 'notes' AND last_successful_sync_at IS NOT NULL",
        ).rows,
        [{ status: 'succeeded' }],
      );
      assert.deepEqual(
        read(
          synced.database,
          'SELECT id FROM notes WHERE title = @title',
          `.parameter set @title "'Groceries'"`,
        ).rows,
        [{ id: 'NOTE-RICH' }],
      );
      // The Apple page lists Notes as imported and Mail as not connected,
      // and offers Notes' accounts and folders to narrow it by.
      const rowOf = async (client: Client, name: string) =>
        (await invoke(client, 'apple_connectors', {})).connectors.find(
          (row: { name: string }) => row.name === name,
        );
      const notesRow = await rowOf(client, 'notes');
      assert.deepEqual(notesRow.selection, {
        scope: {},
        includeAttachments: true,
      });
      assert.deepEqual(notesRow.narrowsBy, {
        accountIds: true,
        collectionIds: true,
      });
      assert.match(
        notesRow.status.text,
        /^Synced (just now|\d+ seconds? ago) · everything\.$/,
      );
      assert.deepEqual((await rowOf(client, 'mail')).status, {
        state: 'off',
        text: 'Not connected.',
        details: [],
        fullDiskAccess: false,
      });
      const notesChoices = await invoke(client, 'apple_connector_choices', {
        connector: 'notes',
      });
      assert.deepEqual(
        notesChoices.choices.map(
          ({
            scope,
            options,
          }: {
            scope: string;
            options: { id: string; label: string }[];
          }) => ({ scope, options }),
        ),
        [
          {
            scope: 'accountIds',
            options: [{ id: 'ACCOUNT-1', label: 'iCloud' }],
          },
          {
            scope: 'collectionIds',
            options: [
              { id: 'FOLDER-NOTES', label: 'iCloud / Notes' },
              { id: 'FOLDER-TRASH', label: 'iCloud / Recently Deleted' },
              { id: 'FOLDER-CHILD', label: 'iCloud / Child' },
            ],
          },
        ],
      );
      assert.equal(notesChoices.datedBy, 'date last edited');
      assert.deepEqual(notesChoices.defaultSelection, {
        scope: {},
        includeAttachments: true,
      });
      assert.match(notesChoices.note, /^Exact containing folders/);
      const write = read(synced.database, 'DELETE FROM raw_notes;');
      assert.match(write.stderr, /readonly/);
      assert.equal(
        read(
          synced.database,
          "SELECT name FROM catalog WHERE name = 'attachments.attachmentRef'",
        ).rows.length,
        1,
      );
      const [attachment] = read(
        synced.database,
        'SELECT attachmentRef FROM attachments WHERE id = @id',
        `.parameter set @id "'ATT-FILE'"`,
      ).rows;
      // A reference names the copy inside the files folder beside the
      // import's database.
      assert.equal(
        readFileSync(
          join(
            dirname(synced.database),
            'files',
            String(attachment.attachmentRef),
          ),
          'utf8',
        ),
        'attached words',
      );
      // An imported connector stays as it is until the user syncs it: Sync on
      // the Apple page imports it again into the same copy, edit included,
      // and returns once the pass has ended.
      retitle('Groceries (synced)');
      await invoke(client, 'apple_sync', {});
      assert.deepEqual(
        read(
          synced.database,
          'SELECT id FROM notes WHERE title = @title',
          `.parameter set @title "'Groceries (synced)'"`,
        ).rows,
        [{ id: 'NOTE-RICH' }],
      );

      // A connector macOS does not allow fails alone, and Notes keeps its import.
      await invoke(client, 'apple_configure', {
        connectors: [
          {
            connector: 'notes',
            scope: JSON.parse(synced.scope),
            includeAttachments: synced.include_attachments === 1,
          },
          { connector: 'messages' },
        ],
      });
      const [kept, messages] = await settled(
        'reported Messages as failed',
        ([notes, messages]) =>
          notes?.sync?.status === 'succeeded' &&
          messages?.sync?.status === 'failed',
      );
      assert.ok(kept && messages?.sync);
      assert.equal(kept.database, synced.database);
      assert.match(String(messages.sync.error), /Full Disk Access/);
      // The Apple page offers to open Full Disk Access for it.
      const messagesRow = await rowOf(client, 'messages');
      assert.equal(messagesRow.status.state, 'failed');
      assert.match(messagesRow.status.text, /Full Disk Access/);
      assert.equal(messagesRow.status.fullDiskAccess, true);
      assert.match(
        await context(client, 'UserPromptSubmit'),
        /^- Messages: last sync failed at .*Full Disk Access.*; not every stream has loaded completely yet; stream_status has each stream's current_as_of\. Database: messages\//m,
      );
      // A connector whose import failed links to its own page.
      assert.match(
        await context(client, 'SessionStart'),
        /^- Messages: last sync failed .* codex:\/\/plugins\/apple\/app\/apple_page\?path=%2Fconnectors%2Fmessages$/m,
      );
      // Sync from one connector's menu imports that connector alone: Notes
      // takes the edit, and Messages keeps the attempt it had.
      retitle('Groceries (Notes only)');
      await invoke(client, 'apple_sync', { connector: 'notes' });
      const [notesAlone, messagesUntouched] = selected();
      assert.deepEqual(
        read(
          String(notesAlone?.database),
          'SELECT id FROM notes WHERE title = @title',
          `.parameter set @title "'Groceries (Notes only)'"`,
        ).rows,
        [{ id: 'NOTE-RICH' }],
      );
      assert.equal(
        messagesUntouched?.sync?.latest_attempt_id,
        messages.sync.latest_attempt_id,
      );

      // An unknown connector fails in the tool, which names it, not in the
      // schema.
      const unknownOptions = await call(client, 'apple_options', {
        connector: 'invalid',
      });
      assert.equal(unknownOptions.isError, true);
      assert.match(
        JSON.stringify(unknownOptions.content),
        /No connector is named invalid\./,
      );
      const unknownConfigure = await call(client, 'apple_configure', {
        connectors: [{ connector: 'invalid' }],
      });
      assert.equal(unknownConfigure.isError, true);
      assert.match(
        JSON.stringify(unknownConfigure.content),
        /No connector named invalid is loaded/,
      );

      // The first chat closes; the other chat changes the selection from here.
      await client.close();
      await transport.close();
      retitle('Groceries (edited)');

      // Switching Notes off on the Apple page, which names only Notes,
      // disconnects it and deletes its import; Messages, which a chat added
      // after setup, stays selected.
      const switched = await invoke(other, 'apple_connector_update', {
        connector: 'notes',
        selection: null,
      });
      assert.deepEqual(
        switched.connectors
          .filter(({ selection }: { selection: unknown }) => selection !== null)
          .map(({ name }: { name: string }) => name),
        ['messages'],
      );
      assert.equal(existsSync(synced.database), false);
      assert.deepEqual(
        selected().map(({ connector }) => connector),
        ['messages'],
      );
      // A chat that never got the start-of-chat status gets it on its next prompt.
      assert.match(
        await context(other, 'UserPromptSubmit'),
        /^- Messages: last sync failed/m,
      );
      // An imported connector is not refreshed; switched on again, Notes
      // imports afresh, with the change made since.
      await invoke(other, 'apple_connector_update', {
        connector: 'notes',
        selection: { scope: {}, includeAttachments: true },
      });
      assert.equal(
        (await imported('Groceries (edited)')).database,
        synced.database,
      );
      // Narrowing Notes to one folder on the Apple page imports it afresh
      // into a new copy, removes the old one and keeps Messages.
      await invoke(other, 'apple_connector_update', {
        connector: 'notes',
        selection: {
          scope: { collectionIds: ['FOLDER-NOTES'] },
          includeAttachments: true,
        },
      });
      const narrowed = notesOf(
        await settled('imported the narrowed Notes', (connectors) => {
          const notes = notesOf(connectors);
          return (
            notes?.sync?.status === 'succeeded' &&
            notes.database !== synced.database
          );
        }),
      );
      assert.deepEqual(JSON.parse(String(narrowed?.scope)), {
        collectionIds: ['FOLDER-NOTES'],
      });
      assert.equal(existsSync(synced.database), false);
      assert.deepEqual(
        selected().map(({ connector }) => connector),
        ['messages', 'notes'],
      );

      // Installing another version deletes this one's folder. The chat still
      // runs the old server, which sends the user to a new chat.
      rmSync(join(plugin, '.codex-plugin'), { recursive: true });
      for (const event of ['UserPromptSubmit', 'UserPromptSubmit'] as const)
        assert.match(await context(other, event), /open a new chat/);
      for (const [name, args] of [
        ['apple_connectors', {}],
        [
          'apple_connector_update',
          {
            connector: 'mail',
            selection: { scope: {}, includeAttachments: true },
          },
        ],
      ] as const) {
        const refused = await call(other, name, args);
        assert.equal(refused.isError, true, name);
        assert.match(JSON.stringify(refused.content), /open a new chat/);
      }
    } finally {
      await client.close();
      await transport.close();
      await other.close();
      await otherTransport.close();
    }
    assert.ok(!diagnostics.includes('Error'), diagnostics);
  },
);

test(
  'Apple setup asks only which connectors, imports each in full or as narrowed before, reports a connector macOS denied, and changes nothing when cancelled',
  {
    timeout: 120_000,
  },
  async (t) => {
    await using scratch = await mkdtempDisposable(join(homes, 'apple-forms-'));
    // The installed plugin, run as Codex runs it.
    const plugin = join(scratch.path, 'plugin');
    const [entry] = JSON.parse(
      readFileSync(join(root, '.agents/plugins/marketplace.json'), 'utf8'),
    ).plugins;
    cpSync(join(root, entry.source.path), plugin, { recursive: true });
    const manifest = JSON.parse(
      readFileSync(join(plugin, '.codex-plugin/plugin.json'), 'utf8'),
    );
    const {
      mcpServers: { apple },
    } = JSON.parse(readFileSync(join(plugin, manifest.mcpServers), 'utf8'));
    const runtime =
      process.env.CODEX_MCP_NODE_PATH ??
      join(
        homedir(),
        '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node',
      );
    // Under this HOME, Notes has a store, macOS denies chat.db and Books was
    // never opened, so it has no stores.
    await noteStoreFixture(
      join(scratch.path, 'Library/Group Containers/group.com.apple.notes'),
    );
    const messages = join(scratch.path, 'Library/Messages');
    mkdirSync(messages, { recursive: true });
    await writeFile(join(messages, 'chat.db'), '');
    chmodSync(join(messages, 'chat.db'), 0o000);
    const client = new Client(
      { name: 'apple-forms', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } } },
    );
    // The fields each form asks for, and the user's answers, one per form.
    const forms: string[][] = [];
    const answers: ElicitResult[] = [];
    client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
      forms.push(
        'requestedSchema' in params
          ? Object.keys(params.requestedSchema.properties)
          : [],
      );
      const answer = answers.shift();
      assert.ok(answer, `unexpected form: ${params.message}`);
      return answer;
    });
    const transport = new StdioClientTransport({
      command: join(plugin, apple.command),
      args: apple.args,
      cwd: join(plugin, apple.cwd),
      env: { HOME: scratch.path, CODEX_MCP_NODE_PATH: runtime, PATH: '' },
      stderr: 'pipe',
    });
    await client.connect(transport, { signal: t.signal, timeout: 5_000 });
    const invoke = async (name: string, args?: Record<string, unknown>) => {
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        {
          signal: t.signal,
          timeout: 60_000,
        },
      );
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.ok(Array.isArray(result.content));
      const block = result.content[0];
      assert.equal(block?.type, 'text');
      return JSON.parse(block.text);
    };
    const setUp = async (...given: ElicitResult[]) => {
      forms.length = 0;
      answers.push(...given);
      const result = await invoke('apple_setup');
      assert.deepEqual(answers, []);
      return result;
    };
    try {
      // One form, the connectors: each chosen connector is imported in full.
      const connected = await setUp({
        action: 'accept',
        content: { connectors: ['notes', 'messages', 'books'] },
      });
      assert.deepEqual(forms, [['connectors']]);
      assert.equal(connected.changed, true);
      assert.deepEqual(
        connected.unavailable.map(
          ({ connector }: { connector: string }) => connector,
        ),
        ['messages', 'books'],
      );
      assert.match(connected.unavailable[0].error, /Full Disk Access/);
      assert.deepEqual(
        connected.connectors.map(
          ({
            connector,
            scope,
            includeAttachments,
          }: Record<string, unknown>) => ({
            connector,
            scope,
            includeAttachments,
          }),
        ),
        [{ connector: 'notes', scope: {}, includeAttachments: true }],
      );
      // Notes is read for real: its background import loads the store's notes.
      const settings = join(
        scratch.path,
        'Library/Application Support/Context Compiler/Apple/settings.sqlite',
      );
      let loaded = false;
      for (let attempt = 0; attempt < 60 && !loaded; attempt++) {
        const [notes] = read(
          settings,
          "SELECT database FROM selected_connectors WHERE connector = 'notes'",
        ).rows;
        loaded =
          notes !== undefined &&
          read(
            join(dirname(settings), notes.database),
            'SELECT title FROM notes',
          ).rows.length > 0;
        if (!loaded) await sleep(500);
      }
      assert.ok(loaded, 'the Notes import never loaded the store’s notes');

      // A selection the user narrowed in chat survives setting up again.
      const narrowed = { collectionIds: ['FOLDER-NOTES'] };
      await invoke('apple_configure', {
        connectors: [
          { connector: 'notes', scope: narrowed, includeAttachments: false },
        ],
      });
      const kept = await setUp({
        action: 'accept',
        content: { connectors: ['notes'] },
      });
      assert.deepEqual(kept.connectors[0]?.scope, narrowed);
      assert.equal(kept.connectors[0]?.includeAttachments, false);

      const cancelled = await setUp({ action: 'cancel' });
      // The selection only: the narrowed Notes import runs in the background
      // and may finish between the two reads, which changes its sync status.
      const selected = ({
        connector,
        scope,
        includeAttachments,
      }: {
        connector: string;
        scope: unknown;
        includeAttachments: boolean;
      }) => ({ connector, scope, includeAttachments });
      assert.equal(cancelled.changed, false);
      assert.deepEqual(
        cancelled.connectors.map(selected),
        kept.connectors.map(selected),
      );
    } finally {
      await client.close();
      await transport.close();
    }
  },
);

// The user's own connectors, where the server looks for them under HOME: the
// Photos connector an agent wrote, as its TypeScript source, and Drafts,
// which does not parse.
async function withConnectors(home: string) {
  const connectors = join(
    home,
    'Library/Application Support/Context Compiler/Connectors',
  );
  mkdirSync(join(connectors, 'photos'), { recursive: true });
  await writeFile(
    join(connectors, 'photos/package.json'),
    JSON.stringify({
      type: 'module',
      exports: './photos-connector.ts',
      contextCompiler: { name: 'photos', title: 'Photos' },
    }),
  );
  await writeFile(
    join(connectors, 'photos/photos-connector.ts'),
    readFileSync(
      join(
        root,
        'packages/connectors/apple/manifest/src/fixtures/photos/photos-connector.ts',
      ),
    ),
  );
  mkdirSync(join(connectors, 'drafts'), { recursive: true });
  await writeFile(
    join(connectors, 'drafts/package.json'),
    JSON.stringify({
      type: 'module',
      exports: './drafts-connector.ts',
      contextCompiler: { name: 'drafts', title: 'Drafts' },
    }),
  );
  await writeFile(
    join(connectors, 'drafts/drafts-connector.ts'),
    'export default {',
  );
  mkdirSync(join(home, 'Pictures'));
  await writeFile(
    join(home, 'Pictures/photos.json'),
    JSON.stringify([
      { id: 'p1', title: 'Beach' },
      { id: 'p2', title: 'Snow' },
    ]),
  );
}

test(
  'a connector the user adds while the server runs imports through it on its own elt and AppleConnector, an edit to it and a preset added to it reach the same chat, and a chat hears of one that does not load',
  { timeout: 120_000 },
  async (t) => {
    await using scratch = await mkdtempDisposable(join(homes, 'apple-e2e-'));
    const plugin = join(scratch.path, 'plugin');
    cpSync(join(root, 'plugins/apple'), plugin, { recursive: true });
    const runtime =
      process.env.CODEX_MCP_NODE_PATH ??
      join(
        homedir(),
        '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node',
      );
    const {
      mcpServers: { apple },
    } = JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8'));
    const transport = new StdioClientTransport({
      command: join(plugin, apple.command),
      args: apple.args,
      cwd: join(plugin, apple.cwd),
      env: { HOME: scratch.path, CODEX_MCP_NODE_PATH: runtime, PATH: '' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'apple-e2e', version: '1.0.0' });
    await client.connect(transport, { signal: t.signal, timeout: 10_000 });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.ok(Array.isArray(result.content));
      return String(result.content[0]?.text);
    };
    try {
      // The server started before the user's connectors existed.
      await withConnectors(scratch.path);
      const context = await call('apple_context', { event: 'SessionStart' });
      await call('apple_configure', { connectors: [{ connector: 'photos' }] });
      const settings = join(
        scratch.path,
        'Library/Application Support/Context Compiler/Apple/settings.sqlite',
      );
      let photos: unknown[] = [];
      for (let attempt = 0; attempt < 60 && photos.length === 0; attempt++) {
        await sleep(500);
        const [selected] = read(
          settings,
          "SELECT database FROM selected_connectors WHERE connector = 'photos'",
        ).rows;
        const database =
          selected === undefined
            ? undefined
            : join(dirname(settings), selected.database);
        if (database !== undefined && existsSync(database))
          photos = read(
            database,
            'SELECT id, title FROM photos ORDER BY id',
          ).rows;
      }
      const connector = join(
        scratch.path,
        'Library/Application Support/Context Compiler/Connectors/photos/photos-connector.ts',
      );
      writeFileSync(
        connector,
        readFileSync(connector, 'utf8').replace(
          "'Open Photos once.'",
          "'Open Pictures once.'",
        ),
      );
      const edited = await call('apple_options', { connector: 'photos' });
      const presets = join(dirname(connector), 'presets');
      mkdirSync(presets);
      const preset = join(presets, 'titled_photos.sql');
      writeFileSync(
        preset,
        [
          '-- titled_photos: Each photo with its title in capitals.',
          '-- id: The photo identifier.',
          '-- title: The title in capitals.',
          'CREATE TEMP VIEW titled_photos AS SELECT id, upper(title) AS title FROM photos;',
        ].join('\n'),
      );
      const withPreset = await call('apple_context', {
        event: 'UserPromptSubmit',
      });
      const [selected] = read(
        settings,
        "SELECT database FROM selected_connectors WHERE connector = 'photos'",
      ).rows;
      const titled = read(
        join(dirname(settings), selected.database),
        'SELECT id, title FROM titled_photos ORDER BY id',
        `.read "${preset}"`,
      );

      assert.match(context, /^- Drafts could not be loaded: /m);
      assert.match(edited, /Open Pictures once\./);
      assert.deepEqual(photos, [
        { id: 'p1', title: 'Beach' },
        { id: 'p2', title: 'Snow' },
      ]);
      assert.ok(
        withPreset.includes(`  Presets in "${presets}": titled_photos`),
        withPreset,
      );
      assert.deepEqual(titled.rows, [
        { id: 'p1', title: 'BEACH' },
        { id: 'p2', title: 'SNOW' },
      ]);
      assert.ok(
        existsSync(
          join(plugin, 'server/connectors/mail/presets/mail_messages.sql'),
        ),
        'the plugin ships the built-in Mail presets',
      );
    } finally {
      await client.close();
      await transport.close();
    }
  },
);

test(
  'a chat adds the monitor it wrote, and the next sync queues the monitor’s instruction into that chat through the codex the server was given',
  { timeout: 120_000 },
  async (t) => {
    await using scratch = await mkdtempDisposable(join(homes, 'apple-e2e-'));
    const plugin = join(scratch.path, 'plugin');
    cpSync(join(root, 'plugins/apple'), plugin, { recursive: true });
    const runtime =
      process.env.CODEX_MCP_NODE_PATH ??
      join(
        homedir(),
        '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node',
      );
    // A real `codex queue` writes into the user's own ~/.codex, so the server
    // gets an executable that records each call instead.
    const calls = join(scratch.path, 'codex-calls.jsonl');
    const codex = join(scratch.path, 'codex');
    writeFileSync(
      codex,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
      { mode: 0o755 },
    );
    await withConnectors(scratch.path);
    const monitor = join(
      scratch.path,
      'Library/Application Support/Context Compiler/Monitors/new-photos',
    );
    mkdirSync(monitor, { recursive: true });
    writeFileSync(
      join(monitor, 'package.json'),
      JSON.stringify({
        type: 'module',
        exports: './new-photos-monitor.ts',
        contextCompiler: {
          name: 'new-photos',
          title: 'New photos',
          description: 'A photo is added to Photos',
          instruction: 'Describe the new photo.',
        },
      }),
    );
    writeFileSync(
      join(monitor, 'new-photos-monitor.ts'),
      `import type { Query } from '@zukhruf/sqlite-federation';

export default {
  async evaluate(sql: Query) {
    return sql.all\`SELECT id FROM photos.photos\`.map((row) => ({ key: String(row.id), data: null }));
  },
};`,
    );
    const {
      mcpServers: { apple },
    } = JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8'));
    const transport = new StdioClientTransport({
      command: join(plugin, apple.command),
      args: apple.args,
      cwd: join(plugin, apple.cwd),
      env: {
        HOME: scratch.path,
        CODEX_MCP_NODE_PATH: runtime,
        CODEX_CLI_PATH: codex,
        PATH: '',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'apple-e2e', version: '1.0.0' });
    await client.connect(transport, { signal: t.signal, timeout: 10_000 });
    try {
      await client.callTool({
        name: 'apple_configure',
        arguments: { connectors: [{ connector: 'photos' }] },
      });
      await client.callTool({ name: 'apple_sync', arguments: {} });
      // Codex names the calling chat in each tool call's _meta.
      const unnamed = await client.callTool({
        name: 'apple_monitor_add',
        arguments: { name: 'new-photos' },
      });
      const added = await client.callTool({
        name: 'apple_monitor_add',
        arguments: { name: 'new-photos' },
        _meta: { threadId: 'chat-e2e' },
      });
      writeFileSync(
        join(scratch.path, 'Pictures/photos.json'),
        JSON.stringify([
          { id: 'p1', title: 'Beach' },
          { id: 'p2', title: 'Snow' },
          { id: 'p3', title: 'Dunes' },
        ]),
      );

      await client.callTool({ name: 'apple_sync', arguments: {} });

      assert.equal(unnamed.isError, true);
      assert.notEqual(added.isError, true, JSON.stringify(added.content));
      assert.deepEqual(
        readFileSync(calls, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
        [
          [
            'queue',
            '--thread',
            'chat-e2e',
            '--message',
            'Monitor "New photos" triggered: Describe the new photo.\nNew matches:\n- p3',
          ],
        ],
      );
      const { structuredContent } = await client.callTool({
        name: 'apple_monitors',
        arguments: {},
      });
      assert.deepEqual(
        z
          .object({
            monitors: z.array(
              z.object({
                chat: z.string().nullable(),
                status: z.object({ state: z.string() }),
              }),
            ),
          })
          .parse(structuredContent).monitors,
        [{ chat: 'codex://threads/chat-e2e', status: { state: 'watching' } }],
      );
    } finally {
      await client.close();
    }
  },
);

// Freezing a server and resuming it needs POSIX signals.
const onUnix = {
  skip:
    process.platform === 'win32'
      ? 'Freezing a server needs POSIX signals'
      : false,
};

// Opens a pipe for writing once a process opens it to read. The open handle
// is the fact that a pass reads the pipe, so the pass runs and holds its
// checkpoints; what is written to the handle, once closed, ends the read. An
// open with no reader fails at once, where a plain write would wait in a
// thread of Node's pool that no test can stop.
async function readerOf(pipe: string) {
  for (let tries = 0; ; tries++) {
    try {
      return await open(pipe, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENXIO'
      ))
        throw error;
      if (tries > 300) assert.fail(`nothing read ${pipe} within 30 s`);
      await sleep(100);
    }
  }
}

// A chat's Apple server on the installed plugin, started as Codex starts it.
// closed settles once its process ended; send signals it only until then,
// so no other process that takes its ID gets the signal.
async function chat(
  signal: AbortSignal,
  plugin: string,
  home: string,
  // The codex a monitor's match is queued through, when the test checks one.
  codex?: string,
) {
  const {
    mcpServers: { apple },
  } = JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8'));
  const transport = new StdioClientTransport({
    command: join(plugin, apple.command),
    args: apple.args,
    cwd: join(plugin, apple.cwd),
    env: {
      HOME: home,
      CODEX_MCP_NODE_PATH:
        process.env.CODEX_MCP_NODE_PATH ??
        join(
          homedir(),
          '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node',
        ),
      ...(codex === undefined ? {} : { CODEX_CLI_PATH: codex }),
      PATH: '',
    },
    stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr?.on('data', (data) => {
    diagnostics += String(data);
  });
  const client = new Client({ name: 'apple-e2e', version: '1.0.0' });
  let ended = false;
  const closed = new Promise<void>((resolve) => {
    client.onclose = () => {
      ended = true;
      resolve();
    };
  });
  await client.connect(transport, { signal, timeout: 10_000 });
  const { pid } = transport;
  assert.ok(pid !== null, 'the server has no process');
  const send = (name: NodeJS.Signals) => {
    if (!ended) process.kill(pid, name);
  };
  return {
    closed,
    send,
    get diagnostics() {
      return diagnostics;
    },
    // The Apple page's Sync of one connector: it returns once that
    // connector's pass ended, with the page's rows.
    sync: (connector: string) =>
      client.callTool(
        { name: 'apple_sync', arguments: { connector } },
        undefined,
        { signal, timeout: 120_000 },
      ),
    configure: (connectors: string[]) =>
      client.callTool(
        {
          name: 'apple_configure',
          arguments: {
            connectors: connectors.map((connector) => ({ connector })),
          },
        },
        undefined,
        { signal },
      ),
    // The Keep current switch on a connector's page.
    watch: (connector: string, watched: boolean) =>
      client.callTool(
        { name: 'apple_connector_watch', arguments: { connector, watched } },
        undefined,
        { signal },
      ),
    connectors: () =>
      client.callTool({ name: 'apple_connectors', arguments: {} }, undefined, {
        signal,
      }),
    // A monitor the chat wrote, added for the chat Codex names in _meta.
    addMonitor: (name: string, thread: string) =>
      client.callTool(
        {
          name: 'apple_monitor_add',
          arguments: { name },
          _meta: { threadId: thread },
        },
        undefined,
        { signal },
      ),
    disconnect: (connector: string) =>
      client.callTool(
        {
          name: 'apple_connector_update',
          arguments: { connector, selection: null },
        },
        undefined,
        { signal },
      ),
    // Closes the chat as Codex does, by ending the server's stdin, and says
    // how long the server took to exit. The SDK sends SIGTERM after 2 s, so
    // a server that ignores the end of its stdin takes longer.
    async hangUp() {
      const started = performance.now();
      await client.close();
      return performance.now() - started;
    },
    async [Symbol.asyncDispose]() {
      send('SIGKILL');
      await client.close();
    },
  };
}

// Where the import of a selected connector is, once it exists.
function importOf(home: string, connector: string): string | undefined {
  const store = join(
    home,
    'Library/Application Support/Context Compiler/Apple',
  );
  const [selected] = read(
    join(store, 'settings.sqlite'),
    `SELECT database FROM selected_connectors WHERE connector = '${connector}'`,
  ).rows;
  const database =
    selected === undefined ? undefined : join(store, selected.database);
  return database !== undefined && existsSync(database) ? database : undefined;
}

// How each pass of a connector's import ended, oldest first.
function passes(home: string, connector: string): string[] {
  const database = importOf(home, connector);
  return database === undefined
    ? []
    : read(
        database,
        'SELECT status FROM sync_attempts ORDER BY attempt_id',
      ).rows.map(({ status }: { status: string }) => status);
}

// The Photos row of the Apple page that a sync returned.
const photosRow = (result: unknown) =>
  z
    .object({
      structuredContent: z.object({
        connectors: z.array(
          z.object({
            name: z.string(),
            status: z.object({ state: z.string(), text: z.string() }),
          }),
        ),
      }),
    })
    .parse(result)
    .structuredContent.connectors.find(({ name }) => name === 'photos')?.status;

// Photos as a connector whose source keeps watching its library, as a real
// app's store is watched: it reports a change whenever photos.json is
// replaced. It stats the library, so a pipe in its place does not block it.
async function withWatchedPhotos(home: string) {
  await withConnectors(home);
  const connector = join(
    home,
    'Library/Application Support/Context Compiler/Connectors/photos/photos-connector.ts',
  );
  const imports = "import { readFile } from 'node:fs/promises';";
  const watcher =
    '  protected async *observe({ streams }: SourceWatchOptions) {\n    yield streams;\n  }';
  const source = readFileSync(connector, 'utf8');
  assert.ok(
    source.includes(imports) && source.includes(watcher),
    'the Photos fixture watches another way',
  );
  writeFileSync(
    connector,
    source
      .replace(imports, "import { readFile, stat } from 'node:fs/promises';")
      .replace(
        watcher,
        `  protected async *observe({ streams, signal }: SourceWatchOptions) {
    yield streams;
    const library = join(homedir(), 'Pictures/photos.json');
    let seen = (await stat(library)).mtimeMs;
    while (!signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const { mtimeMs } = await stat(library);
      if (mtimeMs !== seen) {
        seen = mtimeMs;
        yield streams;
      }
    }
  }`,
      ),
  );
}

// Replaces the Photos library in one step, as an app saves its store, so no
// pass reads it half written.
function photograph(
  home: string,
  photos: readonly { id: string; title: string }[],
) {
  const library = join(home, 'Pictures/photos.json');
  writeFileSync(`${library}.new`, JSON.stringify(photos));
  renameSync(`${library}.new`, library);
}

// The photos the Photos import holds.
function photoIds(home: string): string[] {
  const database = importOf(home, 'photos');
  return database === undefined
    ? []
    : read(database, 'SELECT id FROM photos ORDER BY id').rows.map(
        ({ id }: { id: string }) => id,
      );
}

// Waits until what a test expects holds, or fails with what the servers
// wrote to stderr.
async function eventually(
  holds: () => boolean,
  failure: string,
  said: () => string,
) {
  for (let tries = 0; !holds(); tries++) {
    if (tries > 120) assert.fail(`${failure} within 60 s:\n${said()}`);
    await sleep(500);
  }
}

// Three chats' servers on one Apple store, as when a customer's import
// failed with "Checkpoint … is in use by another run". The first server
// syncs Albums, so it coordinates the store's flights; the second syncs
// Photos and is frozen while its pass reads; then the first dies. Each read
// waits on a pipe until the test writes it. start opens the next chat.
async function frozenLeader(signal: AbortSignal, home: string) {
  const owned = new AsyncDisposableStack();
  try {
    const plugin = join(home, 'plugin');
    cpSync(join(root, 'plugins/apple'), plugin, { recursive: true });
    await withConnectors(home);
    // Albums, another connector an agent wrote: Photos, read from albums.json.
    const albums = join(
      home,
      'Library/Application Support/Context Compiler/Connectors/albums',
    );
    mkdirSync(albums);
    writeFileSync(
      join(albums, 'package.json'),
      JSON.stringify({
        type: 'module',
        exports: './albums-connector.ts',
        contextCompiler: { name: 'albums', title: 'Albums' },
      }),
    );
    writeFileSync(
      join(albums, 'albums-connector.ts'),
      readFileSync(
        join(
          root,
          'packages/connectors/apple/manifest/src/fixtures/photos/photos-connector.ts',
        ),
        'utf8',
      ).replace("'Pictures/photos.json'", "'Pictures/albums.json'"),
    );
    writeFileSync(
      join(home, 'Pictures/albums.json'),
      JSON.stringify([{ id: 'a1', title: 'Summer' }]),
    );
    const start = async () => owned.use(await chat(signal, plugin, home));
    const coordinator = await start();
    await coordinator.configure(['photos', 'albums']);
    for (let attempt = 0; ; attempt++) {
      if (
        passes(home, 'photos').join() === 'succeeded' &&
        passes(home, 'albums').join() === 'succeeded'
      )
        break;
      if (attempt > 120)
        assert.fail(
          `the first imports never loaded:\n${coordinator.diagnostics}`,
        );
      await sleep(500);
    }
    const pictures = {
      photos: join(home, 'Pictures/photos.json'),
      albums: join(home, 'Pictures/albums.json'),
    };
    for (const pipe of Object.values(pictures)) {
      rmSync(pipe);
      spawnSync('/usr/bin/mkfifo', [pipe]);
    }
    // Its Albums pass waits for good: the server dies first.
    coordinator.sync('albums').catch(() => undefined);
    owned.use(await readerOf(pictures.albums));
    const leader = await start();
    const led = leader.sync('photos');
    led.catch(() => undefined);
    const photos = owned.use(await readerOf(pictures.photos));
    leader.send('SIGSTOP');
    owned.defer(() => leader.send('SIGCONT'));
    coordinator.send('SIGKILL');
    await coordinator.closed;
    return {
      start,
      leader,
      led,
      photos,
      pipe: pictures.photos,
      [Symbol.asyncDispose]: () => owned.disposeAsync(),
    };
  } catch (error) {
    await owned.disposeAsync();
    throw error;
  }
}

// How long a replacement's sync must keep waiting on the frozen pass: well
// past the moment a new coordinator would let it run a pass of its own,
// which then fails on the checkpoint the frozen pass holds.
const frozenFor = 5_000;

test(
  'a sync of an import a frozen server is importing, after the server that coordinated the imports died, waits for that pass and returns its outcome without a pass of its own',
  { ...onUnix, timeout: 180_000 },
  async (t) => {
    await using scratch = await mkdtempDisposable(join(homes, 'apple-e2e-'));
    await using scene = await frozenLeader(t.signal, scratch.path);
    const replacement = await scene.start();

    const replaced = replacement.sync('photos');
    const early = await Promise.race([
      replaced,
      sleep(frozenFor).then(() => 'waiting'),
    ]);
    scene.leader.send('SIGCONT');
    await scene.photos.writeFile(
      JSON.stringify([
        { id: 'p1', title: 'Beach' },
        { id: 'p2', title: 'Snow' },
        { id: 'p3', title: 'Dunes' },
      ]),
    );
    await scene.photos.close();
    const [led, joined] = await Promise.all([scene.led, replaced]);

    if (early !== 'waiting')
      assert.fail(
        `the replacement's sync returned while the pass it waits on was frozen: ${JSON.stringify(photosRow(early))}\n${replacement.diagnostics}`,
      );
    assert.equal(photosRow(led)?.state, 'succeeded', JSON.stringify(led));
    assert.deepEqual(photosRow(joined), photosRow(led));
    // The setup's pass, then the frozen server's: the replacement ran none.
    assert.deepEqual(passes(scratch.path, 'photos'), [
      'succeeded',
      'succeeded',
    ]);
    const database = importOf(scratch.path, 'photos');
    assert.ok(database !== undefined);
    assert.deepEqual(read(database, 'SELECT id FROM photos ORDER BY id').rows, [
      { id: 'p1' },
      { id: 'p2' },
      { id: 'p3' },
    ]);
  },
);

test(
  'a sync of an import a frozen server is importing, after the server that coordinated the imports died, runs its own pass once the frozen server is killed',
  { ...onUnix, timeout: 180_000 },
  async (t) => {
    await using scratch = await mkdtempDisposable(join(homes, 'apple-e2e-'));
    await using scene = await frozenLeader(t.signal, scratch.path);
    const replacement = await scene.start();
    const replaced = replacement.sync('photos');
    // The first test shows the replacement waits behind the frozen pass;
    // here that wait is what the kill ends.
    const early = await Promise.race([
      replaced,
      sleep(frozenFor).then(() => 'waiting'),
    ]);
    if (early !== 'waiting')
      assert.fail(
        `the replacement's sync returned while the pass it waits on was frozen: ${JSON.stringify(photosRow(early))}\n${replacement.diagnostics}`,
      );

    scene.leader.send('SIGKILL');
    await scene.leader.closed;
    await scene.photos.close();
    const fed = await readerOf(scene.pipe);
    try {
      await fed.writeFile(JSON.stringify([{ id: 'p3', title: 'Dunes' }]));
    } finally {
      await fed.close();
    }
    const synced = await replaced;

    assert.equal(photosRow(synced)?.state, 'succeeded', JSON.stringify(synced));
    // The setup's pass, the killed server's, which never ended and the
    // replacement recorded failed when its own began, and the replacement's.
    assert.deepEqual(passes(scratch.path, 'photos'), [
      'succeeded',
      'failed',
      'succeeded',
    ]);
    const database = importOf(scratch.path, 'photos');
    assert.ok(database !== undefined);
    assert.deepEqual(read(database, 'SELECT id FROM photos ORDER BY id').rows, [
      { id: 'p1' },
      { id: 'p2' },
      { id: 'p3' },
    ]);
  },
);

const beach = { id: 'p1', title: 'Beach' };
const snow = { id: 'p2', title: 'Snow' };
const dunes = { id: 'p3', title: 'Dunes' };

// Photos kept current by the first chat's server, while a second chat's
// server, open before the switch, stands by for it. The second is stopped
// while the user switches Photos on, so the first takes the watch; the
// second hears of the switch only through the settings.
async function ownedWatch(signal: AbortSignal, home: string) {
  const owned = new AsyncDisposableStack();
  try {
    const plugin = join(home, 'plugin');
    cpSync(join(root, 'plugins/apple'), plugin, { recursive: true });
    await withWatchedPhotos(home);
    const owner = owned.use(await chat(signal, plugin, home));
    const other = owned.use(await chat(signal, plugin, home));
    const said = () => `${owner.diagnostics}\n${other.diagnostics}`;
    await owner.configure(['photos']);
    await eventually(
      () => passes(home, 'photos').join() === 'succeeded',
      'the first import did not load',
      said,
    );
    other.send('SIGSTOP');
    try {
      await owner.watch('photos', true);
      await eventually(
        () => passes(home, 'photos').length === 2,
        'the watch ran no pass',
        said,
      );
    } finally {
      other.send('SIGCONT');
    }
    return {
      owner,
      other,
      said,
      [Symbol.asyncDispose]: () => owned.disposeAsync(),
    };
  } catch (error) {
    await owned.disposeAsync();
    throw error;
  }
}

test(
  'a chat that closes while its server keeps Photos current exits at once, and another chat’s server, open before Photos was switched on, takes the watch and loads the next change with no Sync',
  { ...onUnix, timeout: 180_000 },
  async (t) => {
    await using scratch = await mkdtempDisposable(join(homes, 'apple-e2e-'));
    await using scene = await ownedWatch(t.signal, scratch.path);

    const exitedIn = await scene.owner.hangUp();
    photograph(scratch.path, [beach, snow, dunes]);
    await eventually(
      () => photoIds(scratch.path).includes('p3'),
      'the other chat’s server did not load the change',
      scene.said,
    );

    assert.ok(
      exitedIn < 2_000,
      `the closed chat’s server exited only after ${Math.round(exitedIn)} ms, once the client sent SIGTERM`,
    );
    assert.deepEqual(photoIds(scratch.path), ['p1', 'p2', 'p3']);
    assert.ok(
      passes(scratch.path, 'photos').every((status) => status === 'succeeded'),
      JSON.stringify(passes(scratch.path, 'photos')),
    );
  },
);

test(
  'a server Codex stops with SIGTERM while it keeps Photos current exits, and another chat’s server takes the watch',
  { ...onUnix, timeout: 180_000 },
  async (t) => {
    await using scratch = await mkdtempDisposable(join(homes, 'apple-e2e-'));
    await using scene = await ownedWatch(t.signal, scratch.path);

    scene.owner.send('SIGTERM');
    const exited = await Promise.race([
      scene.owner.closed.then(() => true),
      sleep(5_000).then(() => false),
    ]);
    photograph(scratch.path, [beach, snow, dunes]);
    await eventually(
      () => photoIds(scratch.path).includes('p3'),
      'the other chat’s server did not load the change',
      scene.said,
    );

    assert.ok(exited, 'the server kept running 5 s after SIGTERM');
    assert.deepEqual(photoIds(scratch.path), ['p1', 'p2', 'p3']);
  },
);

test(
  'switching Keep current off in a chat whose server does not own the watch stops it, and a change then waits for Sync',
  { ...onUnix, timeout: 180_000 },
  async (t) => {
    await using scratch = await mkdtempDisposable(join(homes, 'apple-e2e-'));
    await using scene = await ownedWatch(t.signal, scratch.path);

    const switched = await scene.other.watch('photos', false);
    // The owner hears of the switch within a second.
    await sleep(2_000);
    photograph(scratch.path, [beach, snow, dunes]);
    await sleep(3_000);
    const unwatched = photoIds(scratch.path);
    const synced = await scene.other.sync('photos');

    assert.notEqual(switched.isError, true, JSON.stringify(switched.content));
    assert.deepEqual(unwatched, ['p1', 'p2']);
    assert.equal(photosRow(synced)?.state, 'succeeded', JSON.stringify(synced));
    assert.deepEqual(photoIds(scratch.path), ['p1', 'p2', 'p3']);
    assert.deepEqual(passes(scratch.path, 'photos'), [
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
  },
);

test(
  'a Sync of Photos from another chat while a watch keeps it current runs no pass of its own',
  { ...onUnix, timeout: 180_000 },
  async (t) => {
    await using scratch = await mkdtempDisposable(join(homes, 'apple-e2e-'));
    await using scene = await ownedWatch(t.signal, scratch.path);

    const synced = await scene.other.sync('photos');

    assert.equal(photosRow(synced)?.state, 'succeeded', JSON.stringify(synced));
    assert.deepEqual(passes(scratch.path, 'photos'), [
      'succeeded',
      'succeeded',
    ]);
  },
);

test(
  'with two chats open, each change to Photos is loaded by one pass, not one per server',
  { timeout: 180_000 },
  async (t) => {
    await using scratch = await mkdtempDisposable(join(homes, 'apple-e2e-'));
    const plugin = join(scratch.path, 'plugin');
    cpSync(join(root, 'plugins/apple'), plugin, { recursive: true });
    await withWatchedPhotos(scratch.path);
    await using first = await chat(t.signal, plugin, scratch.path);
    await using second = await chat(t.signal, plugin, scratch.path);
    const said = () => `${first.diagnostics}\n${second.diagnostics}`;
    await first.configure(['photos']);
    await eventually(
      () => passes(scratch.path, 'photos').join() === 'succeeded',
      'the first import did not load',
      said,
    );

    await first.watch('photos', true);
    await eventually(
      () => passes(scratch.path, 'photos').length === 2,
      'the watch ran no pass',
      said,
    );
    // Both servers have heard of the switch by now.
    await sleep(2_000);
    photograph(scratch.path, [beach, snow, dunes]);
    await eventually(
      () => photoIds(scratch.path).includes('p3'),
      'no server loaded the change',
      said,
    );
    await sleep(3_000);

    assert.deepEqual(passes(scratch.path, 'photos'), [
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
  },
);

test(
  'only the connectors switched on are kept current: Photos loads a change with no Sync, while Albums, connected but never switched on, waits for Sync',
  { timeout: 180_000 },
  async (t) => {
    await using scratch = await mkdtempDisposable(join(homes, 'apple-e2e-'));
    const plugin = join(scratch.path, 'plugin');
    cpSync(join(root, 'plugins/apple'), plugin, { recursive: true });
    await withWatchedPhotos(scratch.path);
    // Albums, another connector that watches its own library, albums.json.
    const connectors = join(
      scratch.path,
      'Library/Application Support/Context Compiler/Connectors',
    );
    mkdirSync(join(connectors, 'albums'));
    writeFileSync(
      join(connectors, 'albums/package.json'),
      JSON.stringify({
        type: 'module',
        exports: './albums-connector.ts',
        contextCompiler: { name: 'albums', title: 'Albums' },
      }),
    );
    writeFileSync(
      join(connectors, 'albums/albums-connector.ts'),
      readFileSync(
        join(connectors, 'photos/photos-connector.ts'),
        'utf8',
      ).replaceAll("'Pictures/photos.json'", "'Pictures/albums.json'"),
    );
    const albums = join(scratch.path, 'Pictures/albums.json');
    writeFileSync(albums, JSON.stringify([{ id: 'a1', title: 'Summer' }]));
    await using user = await chat(t.signal, plugin, scratch.path);
    await user.configure(['photos', 'albums']);
    await eventually(
      () =>
        passes(scratch.path, 'photos').join() === 'succeeded' &&
        passes(scratch.path, 'albums').join() === 'succeeded',
      'the first imports did not load',
      () => user.diagnostics,
    );

    const switched = await user.watch('photos', true);
    photograph(scratch.path, [beach, snow, dunes]);
    writeFileSync(
      `${albums}.new`,
      JSON.stringify([
        { id: 'a1', title: 'Summer' },
        { id: 'a2', title: 'Winter' },
      ]),
    );
    renameSync(`${albums}.new`, albums);
    await eventually(
      () => photoIds(scratch.path).includes('p3'),
      'Photos did not load the change',
      () => user.diagnostics,
    );
    await sleep(3_000);
    const database = importOf(scratch.path, 'albums');
    assert.ok(database !== undefined);
    const albumIds = read(database, 'SELECT id FROM photos ORDER BY id').rows;
    // The rows the switch returned, which the page shows, and the rows the
    // page reads again later.
    const watchedOf = (result: unknown) =>
      z
        .object({
          structuredContent: z.object({
            connectors: z.array(
              z.object({ name: z.string(), watched: z.boolean() }),
            ),
          }),
        })
        .parse(result)
        .structuredContent.connectors.filter(({ name }) =>
          ['albums', 'photos'].includes(name),
        );
    const listed = watchedOf(await user.connectors());

    assert.deepEqual(albumIds, [{ id: 'a1' }]);
    assert.deepEqual(passes(scratch.path, 'albums'), ['succeeded']);
    for (const rows of [watchedOf(switched), listed])
      assert.deepEqual(rows, [
        { name: 'albums', watched: false },
        { name: 'photos', watched: true },
      ]);
  },
);

test(
  'a server whose plugin was updated gives up the watch while its chat stays open, and a chat on the new version takes it and loads the next change',
  { timeout: 180_000 },
  async (t) => {
    await using scratch = await mkdtempDisposable(join(homes, 'apple-e2e-'));
    const old = join(scratch.path, 'plugin-old');
    const current = join(scratch.path, 'plugin-new');
    cpSync(join(root, 'plugins/apple'), old, { recursive: true });
    cpSync(old, current, { recursive: true });
    await withWatchedPhotos(scratch.path);
    await using stale = await chat(t.signal, old, scratch.path);
    await stale.configure(['photos']);
    await eventually(
      () => passes(scratch.path, 'photos').join() === 'succeeded',
      'the first import did not load',
      () => stale.diagnostics,
    );
    await stale.watch('photos', true);
    await eventually(
      () => passes(scratch.path, 'photos').length === 2,
      'the watch ran no pass',
      () => stale.diagnostics,
    );

    // Installing another version deletes this version's folder.
    rmSync(old, { recursive: true, force: true });
    await sleep(2_000);
    photograph(scratch.path, [beach, snow, dunes]);
    await sleep(3_000);
    const beforeNewChat = photoIds(scratch.path);
    const passesBeforeNewChat = passes(scratch.path, 'photos');
    await using fresh = await chat(t.signal, current, scratch.path);
    await eventually(
      () => photoIds(scratch.path).includes('p3'),
      'the new version’s server did not load the change',
      () => `${stale.diagnostics}\n${fresh.diagnostics}`,
    );
    const staleOpen = await Promise.race([
      stale.closed.then(() => false),
      sleep(0).then(() => true),
    ]);

    assert.deepEqual(beforeNewChat, ['p1', 'p2']);
    assert.deepEqual(passesBeforeNewChat, ['succeeded', 'succeeded']);
    assert.ok(staleOpen, 'the old version’s server ended');
    assert.deepEqual(photoIds(scratch.path), ['p1', 'p2', 'p3']);
  },
);

test(
  'disconnecting Photos while its watched pass reads keeps the import until the pass ends, then the watch stops and removes it for good',
  { ...onUnix, timeout: 180_000 },
  async (t) => {
    await using scratch = await mkdtempDisposable(join(homes, 'apple-e2e-'));
    const plugin = join(scratch.path, 'plugin');
    cpSync(join(root, 'plugins/apple'), plugin, { recursive: true });
    await withWatchedPhotos(scratch.path);
    await using user = await chat(t.signal, plugin, scratch.path);
    await user.configure(['photos']);
    await eventually(
      () => passes(scratch.path, 'photos').join() === 'succeeded',
      'the first import did not load',
      () => user.diagnostics,
    );
    await user.watch('photos', true);
    await eventually(
      () => passes(scratch.path, 'photos').length === 2,
      'the watch ran no pass',
      () => user.diagnostics,
    );
    const database = importOf(scratch.path, 'photos');
    assert.ok(database !== undefined);
    const directory = dirname(database);
    // A pipe in place of the library: the watch sees a change, and its pass
    // reads until the test writes the pipe.
    const library = join(scratch.path, 'Pictures/photos.json');
    rmSync(library);
    spawnSync('/usr/bin/mkfifo', [library]);
    const reading = await readerOf(library);

    let disconnected;
    let keptWhileReading;
    try {
      disconnected = await user.disconnect('photos');
      // The watch hears of the removal within a second, and its pass reads on.
      await sleep(2_000);
      keptWhileReading = existsSync(directory);
      await reading.writeFile(JSON.stringify([beach, snow, dunes]));
    } finally {
      await reading.close();
    }
    await eventually(
      () => !existsSync(directory),
      'the import was not removed',
      () => user.diagnostics,
    );
    await sleep(3_000);

    assert.notEqual(
      disconnected.isError,
      true,
      JSON.stringify(disconnected.content),
    );
    assert.ok(keptWhileReading, 'the import was removed while its pass read');
    assert.equal(existsSync(directory), false);
  },
);

test(
  'a monitor’s match that a watched pass loaded is queued into its chat with no Sync',
  { timeout: 180_000 },
  async (t) => {
    await using scratch = await mkdtempDisposable(join(homes, 'apple-e2e-'));
    const plugin = join(scratch.path, 'plugin');
    cpSync(join(root, 'plugins/apple'), plugin, { recursive: true });
    // A real `codex queue` writes into the user's own ~/.codex, so the server
    // gets an executable that records each call instead.
    const calls = join(scratch.path, 'codex-calls.jsonl');
    const codex = join(scratch.path, 'codex');
    writeFileSync(
      codex,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
      { mode: 0o755 },
    );
    await withWatchedPhotos(scratch.path);
    const monitor = join(
      scratch.path,
      'Library/Application Support/Context Compiler/Monitors/new-photos',
    );
    mkdirSync(monitor, { recursive: true });
    writeFileSync(
      join(monitor, 'package.json'),
      JSON.stringify({
        type: 'module',
        exports: './new-photos-monitor.ts',
        contextCompiler: {
          name: 'new-photos',
          title: 'New photos',
          description: 'A photo is added to Photos',
          instruction: 'Describe the new photo.',
        },
      }),
    );
    writeFileSync(
      join(monitor, 'new-photos-monitor.ts'),
      `import type { Query } from '@zukhruf/sqlite-federation';

export default {
  async evaluate(sql: Query) {
    return sql.all\`SELECT id FROM photos.photos\`.map((row) => ({ key: String(row.id), data: null }));
  },
};`,
    );
    await using user = await chat(t.signal, plugin, scratch.path, codex);
    await user.configure(['photos']);
    await eventually(
      () => passes(scratch.path, 'photos').join() === 'succeeded',
      'the first import did not load',
      () => user.diagnostics,
    );
    const added = await user.addMonitor('new-photos', 'chat-e2e');
    await user.watch('photos', true);
    await eventually(
      () => passes(scratch.path, 'photos').length === 2,
      'the watch ran no pass',
      () => user.diagnostics,
    );

    photograph(scratch.path, [beach, snow, dunes]);
    await eventually(
      () => existsSync(calls),
      'no match was queued',
      () => user.diagnostics,
    );

    assert.notEqual(added.isError, true, JSON.stringify(added.content));
    assert.deepEqual(
      readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      [
        [
          'queue',
          '--thread',
          'chat-e2e',
          '--message',
          'Monitor "New photos" triggered: Describe the new photo.\nNew matches:\n- p3',
        ],
      ],
    );
  },
);

test(
  'a watched connector whose source fails is shown failed and stops alone, while another watched connector keeps loading each change',
  { timeout: 180_000 },
  async (t) => {
    await using scratch = await mkdtempDisposable(join(homes, 'apple-e2e-'));
    const plugin = join(scratch.path, 'plugin');
    cpSync(join(root, 'plugins/apple'), plugin, { recursive: true });
    await withWatchedPhotos(scratch.path);
    // Albums, another connector that watches its own library, albums.json;
    // its watch fails once that library is gone.
    const connectors = join(
      scratch.path,
      'Library/Application Support/Context Compiler/Connectors',
    );
    mkdirSync(join(connectors, 'albums'));
    writeFileSync(
      join(connectors, 'albums/package.json'),
      JSON.stringify({
        type: 'module',
        exports: './albums-connector.ts',
        contextCompiler: { name: 'albums', title: 'Albums' },
      }),
    );
    writeFileSync(
      join(connectors, 'albums/albums-connector.ts'),
      readFileSync(
        join(connectors, 'photos/photos-connector.ts'),
        'utf8',
      ).replaceAll("'Pictures/photos.json'", "'Pictures/albums.json'"),
    );
    const albums = join(scratch.path, 'Pictures/albums.json');
    writeFileSync(albums, JSON.stringify([{ id: 'a1', title: 'Summer' }]));
    await using user = await chat(t.signal, plugin, scratch.path);
    await user.configure(['photos', 'albums']);
    await eventually(
      () =>
        passes(scratch.path, 'photos').join() === 'succeeded' &&
        passes(scratch.path, 'albums').join() === 'succeeded',
      'the first imports did not load',
      () => user.diagnostics,
    );
    await user.watch('photos', true);
    await user.watch('albums', true);
    await eventually(
      () =>
        passes(scratch.path, 'photos').length === 2 &&
        passes(scratch.path, 'albums').length === 2,
      'the watches ran no pass',
      () => user.diagnostics,
    );

    rmSync(albums);
    await eventually(
      () => passes(scratch.path, 'albums').at(-1) === 'failed',
      'the Albums watch did not fail',
      () => user.diagnostics,
    );
    photograph(scratch.path, [beach, snow, dunes]);
    await eventually(
      () => photoIds(scratch.path).includes('p3'),
      'Photos did not load the change',
      () => user.diagnostics,
    );
    const status = (name: string, result: unknown) =>
      z
        .object({
          structuredContent: z.object({
            connectors: z.array(
              z.object({
                name: z.string(),
                status: z.object({ state: z.string(), text: z.string() }),
              }),
            ),
          }),
        })
        .parse(result)
        .structuredContent.connectors.find((row) => row.name === name)?.status;
    const rows = await user.connectors();

    assert.equal(status('albums', rows)?.state, 'failed');
    assert.match(status('albums', rows)?.text ?? '', /ENOENT|no such file/);
    assert.equal(status('photos', rows)?.state, 'succeeded');
    assert.deepEqual(photoIds(scratch.path), ['p1', 'p2', 'p3']);
  },
);
