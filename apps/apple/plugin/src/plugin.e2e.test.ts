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
  readdirSync,
  readFileSync,
} from 'node:fs';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

// A selected_apps row with its import's latest pass from sync_status, as the
// query-apple skill reads them.
type SelectedApp = {
  app: string;
  scope: string;
  include_attachments: 0 | 1;
  database: string;
  connection_error: string | null;
  sync:
    | {
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

test('the committed Apple plugin installs from the repo marketplace, sets up through Codex bundled Node, keeps its import current in the background and serves it to the skill read command', {
  timeout: 180_000,
}, async (t) => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'apple-e2e-'));
  const marketplace = JSON.parse(
    readFileSync(join(root, '.agents/plugins/marketplace.json'), 'utf8'),
  );
  const [entry] = marketplace.plugins;
  assert.equal(entry.name, 'apple');
  // Codex copies the plugin directory into its cache and runs it from there.
  const plugin = join(scratch.path, 'plugin');
  cpSync(join(root, entry.source.path), plugin, { recursive: true });
  for (const path of readdirSync(plugin, { recursive: true, encoding: 'utf8' }))
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
  const call = (client: Client, name: string, args?: Record<string, unknown>) =>
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
  // The skill's entry point: the selection, with no tool call.
  const settingsFile = join(
    scratch.path,
    'Library/Application Support/Context Compiler/Apple/settings.sqlite',
  );
  const selected = (): SelectedApp[] =>
    read(
      settingsFile,
      'SELECT app, scope, include_attachments, database, connection_error FROM selected_apps',
    ).rows.map((app: Omit<SelectedApp, 'sync'>) => ({
      ...app,
      sync: read(
        app.database,
        'SELECT status, error, last_successful_sync_at FROM sync_status',
      ).rows[0],
    }));
  // Waits for the leading server until the selected apps reach the state done
  // looks for.
  const settled = async (
    what: string,
    done: (apps: SelectedApp[]) => boolean,
  ): Promise<SelectedApp[]> => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const apps = selected();
      if (done(apps)) return apps;
      await sleep(500);
    }
    assert.fail(`The import never ${what}`);
  };
  const imported = async (title: string) => {
    const [notes] = await settled(
      `showed ${title}`,
      ([notes]) =>
        notes?.sync?.status === 'succeeded' &&
        read(
          notes.database,
          'SELECT title FROM notes WHERE title = @title',
          `.parameter set @title "'${title}'"`,
        ).rows.length === 1,
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
    return { action: 'accept', content: { apps: ['notes'] } };
  });
  const other = new Client({ name: 'another-chat', version: '1.0.0' });
  const transport = await connect(client);
  const otherTransport = await connect(other);
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      [
        'apple_configure',
        'apple_options',
        'apple_settings_read',
        'apple_settings_update',
        'apple_setup',
      ],
    );
    // The server names the installed version, which decides who leads.
    assert.equal(client.getServerVersion()?.version, manifest.version);
    // The plugin page's native Settings section names two of those tools.
    assert.deepEqual(
      OpenAISettingsCapabilitySchema.parse(
        client.getServerCapabilities()?.experimental?.['openai/settings'],
      ),
      { readTool: 'apple_settings_read', updateTool: 'apple_settings_update' },
    );
    assert.deepEqual(selected(), []);
    assert.deepEqual((await call(other, 'apple_setup')).content, [
      { type: 'text', text: 'Client does not support form elicitation.' },
    ]);

    // Setup returns once the answers are saved; the import runs apart from it.
    const setUp = await invoke(client, 'apple_setup');
    // One form: the apps. Notes is imported in full without further questions.
    assert.equal(forms.length, 1);
    assert.match(forms[0] ?? '', /Choose the Apple apps/);
    assert.deepEqual(setUp.unavailable, []);
    assert.deepEqual(
      setUp.apps.map(({ app }: { app: string }) => app),
      ['notes'],
    );
    const synced = await imported('Groceries');
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
    const notesSetting = settings.schema.properties?.notes as
      | { description?: string }
      | undefined;
    assert.match(
      String(notesSetting?.description),
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

    // An app macOS does not allow fails alone, and Notes keeps its import.
    await invoke(client, 'apple_configure', {
      apps: [
        {
          app: 'notes',
          scope: JSON.parse(synced.scope),
          includeAttachments: synced.include_attachments === 1,
        },
        { app: 'messages' },
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

    // A change in Notes reaches the import while nobody calls a tool.
    retitle('Groceries (edited)');
    assert.equal(
      (await imported('Groceries (edited)')).database,
      synced.database,
    );
    assert.equal(
      (await call(client, 'apple_options', { app: 'invalid' })).isError,
      true,
    );

    // When the leading chat closes, another chat's server keeps importing.
    await client.close();
    await transport.close();
    retitle('Groceries (after handoff)');
    await imported('Groceries (after handoff)');

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
      selected().map(({ app }) => app),
      ['messages'],
    );
  } finally {
    await client.close();
    await transport.close();
    await other.close();
    await otherTransport.close();
  }
  assert.ok(!diagnostics.includes('Error'), diagnostics);
});

test('Apple setup asks only which apps, imports each in full or as narrowed before, reports an app macOS denied, and changes nothing when cancelled', {
  timeout: 120_000,
}, async (t) => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'apple-forms-'));
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
  // Under this HOME, Notes has a store and macOS denies chat.db.
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
    const result = await client.callTool({ name, arguments: args }, undefined, {
      signal: t.signal,
      timeout: 60_000,
    });
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
    // One form, the apps: each chosen app is imported in full.
    const connected = await setUp({
      action: 'accept',
      content: { apps: ['notes', 'messages'] },
    });
    assert.deepEqual(forms, [['apps']]);
    assert.equal(connected.changed, true);
    assert.deepEqual(
      connected.unavailable.map(({ app }: { app: string }) => app),
      ['messages'],
    );
    assert.match(connected.unavailable[0].error, /Full Disk Access/);
    assert.deepEqual(
      connected.apps.map(
        ({ app, scope, includeAttachments }: Record<string, unknown>) => ({
          app,
          scope,
          includeAttachments,
        }),
      ),
      [{ app: 'notes', scope: {}, includeAttachments: true }],
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
        "SELECT database FROM selected_apps WHERE app = 'notes'",
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
      apps: [{ app: 'notes', scope: narrowed, includeAttachments: false }],
    });
    const kept = await setUp({
      action: 'accept',
      content: { apps: ['notes'] },
    });
    assert.deepEqual(kept.apps[0]?.scope, narrowed);
    assert.equal(kept.apps[0]?.includeAttachments, false);

    const cancelled = await setUp({ action: 'cancel' });
    assert.equal(cancelled.changed, false);
    assert.deepEqual(cancelled.apps, kept.apps);
  } finally {
    await client.close();
    await transport.close();
  }
});
