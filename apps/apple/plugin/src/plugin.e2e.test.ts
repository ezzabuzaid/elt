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
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
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
import {
  OpenAISettingsCapabilitySchema,
  OpenAISettingsReadResultSchema,
  OpenAISettingsUpdateResultSchema,
} from '@openai/mcp-extensions/server';

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
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'apple-e2e-'));
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
      ).rows.map((row: Omit<SelectedConnector, 'sync'>) => ({
        ...row,
        sync: read(
          row.database,
          'SELECT latest_attempt_id, status, error, last_successful_sync_at FROM sync_status',
        ).rows[0],
      }));
    // Waits for the leading server until the selected connectors reach the
    // state done looks for.
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
      assert.deepEqual(
        (await client.listTools()).tools.map((tool) => tool.name).sort(),
        [
          'apple_configure',
          'apple_context',
          'apple_meeting_chat',
          'apple_options',
          'apple_person_note',
          'apple_settings_read',
          'apple_settings_update',
          'apple_setup',
        ],
      );
      // Only the hooks call apple_context; Codex keeps it from the model.
      assert.deepEqual(
        (await client.listTools()).tools.find(
          (tool) => tool.name === 'apple_context',
        )?._meta,
        { ui: { visibility: ['app'] } },
      );
      // Codex shows these instructions with the tools.
      assert.match(String(client.getInstructions()), /\$query-apple/);
      // The server names the installed version, which decides who leads.
      assert.equal(client.getServerVersion()?.version, manifest.version);
      // The plugin page's native Settings section names two of those tools.
      assert.deepEqual(
        OpenAISettingsCapabilitySchema.parse(
          client.getServerCapabilities()?.experimental?.['openai/settings'],
        ),
        {
          readTool: 'apple_settings_read',
          updateTool: 'apple_settings_update',
        },
      );
      assert.deepEqual(selected(), []);
      assert.match(
        await context(client, 'SessionStart'),
        /no connectors are set up\. Use \$setup-apple/,
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
        /^- Notes: synced at \d{4}-\d\d-\d\dT[\d:.]+Z\. Database: notes\/[0-9a-f]{16}\/data\.sqlite$/m,
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
      const settings = OpenAISettingsReadResultSchema.parse(
        (await call(client, 'apple_settings_read', {})).structuredContent,
      );
      assert.equal(settings.values.notes, true);
      assert.equal(settings.values.mail, false);
      const notesSetting = settings.schema.properties?.notes;
      assert.ok(
        typeof notesSetting === 'object' &&
          notesSetting !== null &&
          'description' in notesSetting &&
          typeof notesSetting.description === 'string',
      );
      assert.match(
        notesSetting.description,
        /^Synced (just now|\d+ seconds? ago) · everything\.$/,
      );
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
      assert.equal(
        readFileSync(String(attachment.attachmentRef), 'utf8'),
        'attached words',
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
      assert.match(
        await context(client, 'UserPromptSubmit'),
        /^- Messages: last sync failed at .*Full Disk Access.*; no data yet\. Database: messages\//m,
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

      // When the leading chat closes, another chat's server leads.
      await client.close();
      await transport.close();
      retitle('Groceries (edited)');

      // Switching Notes off on the Settings page disconnects it and deletes
      // its import; Messages stays selected.
      const switched = OpenAISettingsUpdateResultSchema.parse(
        (await call(other, 'apple_settings_update', { set: { notes: false } }))
          .structuredContent,
      );
      assert.equal(switched.values.notes, false);
      assert.equal(switched.values.messages, true);
      assert.equal(existsSync(synced.database), false);
      assert.deepEqual(
        selected().map(({ connector }) => connector),
        ['messages'],
      );
      // The selection change imports again what no pass loaded: Messages
      // fails once more.
      await settled(
        'retried Messages',
        ([retried]) =>
          retried?.sync?.latest_attempt_id !==
            messages.sync?.latest_attempt_id &&
          retried?.sync?.status === 'failed',
      );
      // A chat that never got the start-of-chat status gets it on its next prompt.
      assert.match(
        await context(other, 'UserPromptSubmit'),
        /^- Messages: last sync failed/m,
      );
      // An imported connector is not refreshed; switched on again, Notes
      // imports afresh, with the change made since, through the new leader.
      await call(other, 'apple_settings_update', { set: { notes: true } });
      assert.equal(
        (await imported('Groceries (edited)')).database,
        synced.database,
      );

      // Installing another version deletes this one's folder. The chat still
      // runs the old server, which sends the user to a new chat to set up
      // Apple, and keeps serving the proactive chats' records, which outlive
      // plugin updates.
      rmSync(join(plugin, '.codex-plugin'), { recursive: true });
      for (const event of ['UserPromptSubmit', 'UserPromptSubmit'] as const) {
        const updated = await context(other, event);
        assert.match(updated, /open a new chat/);
        assert.match(updated, /apple_person_note/);
      }
      const refused = await call(other, 'apple_settings_read', {});
      assert.equal(refused.isError, true);
      assert.match(JSON.stringify(refused.content), /open a new chat/);
      const noted = await call(other, 'apple_person_note', {
        email: 'ann@example.com',
        name: 'Ann',
        note: 'Leads design at Example.',
      });
      assert.notEqual(noted.isError, true, JSON.stringify(noted.content));
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
    await using scratch = await mkdtempDisposable(
      join(tmpdir(), 'apple-forms-'),
    );
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
          read(notes.database, 'SELECT title FROM notes').rows.length > 0;
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
      assert.equal(cancelled.changed, false);
      assert.deepEqual(cancelled.connectors, kept.connectors);
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
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'apple-e2e-'));
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
        if (selected !== undefined && existsSync(selected.database))
          photos = read(
            selected.database,
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
        selected.database,
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
  'an import a pass loaded only in part imports again when the next chat starts, until every row arrives',
  { timeout: 120_000 },
  async (t) => {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'apple-e2e-'));
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
    // Codex starts a server for each chat.
    const chat = async () => {
      const transport = new StdioClientTransport({
        command: join(plugin, apple.command),
        args: apple.args,
        cwd: join(plugin, apple.cwd),
        env: { HOME: scratch.path, CODEX_MCP_NODE_PATH: runtime, PATH: '' },
        stderr: 'pipe',
      });
      const client = new Client({ name: 'apple-e2e', version: '1.0.0' });
      await client.connect(transport, { signal: t.signal, timeout: 10_000 });
      return { client, transport };
    };
    const settings = join(
      scratch.path,
      'Library/Application Support/Context Compiler/Apple/settings.sqlite',
    );
    // The photos a reader sees once the import's latest pass ends as status.
    const photosOnceEnded = async (status: string) => {
      for (let attempt = 0; attempt < 60; attempt++) {
        const [selected] = read(
          settings,
          "SELECT database FROM selected_connectors WHERE connector = 'photos'",
        ).rows;
        if (
          selected !== undefined &&
          existsSync(selected.database) &&
          read(selected.database, 'SELECT status FROM sync_status').rows[0]
            ?.status === status
        )
          return read(
            selected.database,
            'SELECT id, title FROM photos ORDER BY id',
          ).rows;
        await sleep(500);
      }
      assert.fail(`The Photos import never ended ${status}`);
    };
    await withConnectors(scratch.path);
    const pictures = join(scratch.path, 'Pictures/photos.json');
    await writeFile(
      pictures,
      JSON.stringify([{ id: 'p1', title: 'Beach' }, 'not a photo']),
    );

    const first = await chat();
    let partly: unknown[];
    try {
      const configured = await first.client.callTool({
        name: 'apple_configure',
        arguments: { connectors: [{ connector: 'photos' }] },
      });
      assert.notEqual(configured.isError, true);
      partly = await photosOnceEnded('partial');
    } finally {
      await first.client.close();
      await first.transport.close();
    }
    await writeFile(
      pictures,
      JSON.stringify([
        { id: 'p1', title: 'Beach' },
        { id: 'p2', title: 'Snow' },
      ]),
    );
    const next = await chat();
    let complete: unknown[];
    try {
      complete = await photosOnceEnded('succeeded');
    } finally {
      await next.client.close();
      await next.transport.close();
    }

    assert.deepEqual(partly, [{ id: 'p1', title: 'Beach' }]);
    assert.deepEqual(complete, [
      { id: 'p1', title: 'Beach' },
      { id: 'p2', title: 'Snow' },
    ]);
  },
);
