import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import { Pipeline, PipelineError } from '@workspace/elt';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

// This package's folder, which holds its manifest.
const folder = fileURLToPath(new URL('..', import.meta.url));

// The SDK finds WhatsApp's container under HOME when its module loads, so the
// connector is imported only after HOME points at the test's folder. node
// --test runs this file in its own process, so the module loads once.
async function connectorUnder(home: string): Promise<AppleConnector> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const { default: WhatsAppConnector } =
      await import('./whatsapp-connector.ts');
    const { contextCompiler } = JSON.parse(
      readFileSync(join(folder, 'package.json'), 'utf8'),
    );
    // WhatsApp reads nothing through EventKit.
    return new WhatsAppConnector(
      { grantee: 'Codex', eventKitHelper: '' },
      { name: contextCompiler.name, title: contextCompiler.title, folder },
    );
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

// The stores a chat-narrowed import reads and the one that shows what it
// leaves out, with the tables the reader reads as WhatsApp 26.38 creates them:
// one chat with one message, and one status. The other stores are missing.
function whatsappContainer(home: string): void {
  const container = join(
    home,
    'Library/Group Containers/group.net.whatsapp.WhatsApp.shared',
  );
  const store = (file: string, sql: string) => {
    const path = join(container, file);
    mkdirSync(dirname(path), { recursive: true });
    using database = new DatabaseSync(path);
    database.exec(`PRAGMA journal_mode = WAL; ${sql}`);
  };
  store(
    'ChatStorage.sqlite',
    `
    CREATE TABLE ZWABLACKLISTITEM ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZJID VARCHAR );
    CREATE TABLE ZWACHATPUSHCONFIG ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZALERTS INTEGER, ZMUTEDUNTIL TIMESTAMP, ZJID VARCHAR, ZRINGTONE VARCHAR, ZSOUND VARCHAR );
    CREATE TABLE ZWACHATSESSION ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZARCHIVED INTEGER, ZCONTACTABID INTEGER, ZFLAGS INTEGER, ZHIDDEN INTEGER, ZIDENTITYVERIFICATIONEPOCH INTEGER, ZIDENTITYVERIFICATIONSTATE INTEGER, ZMESSAGECOUNTER INTEGER, ZREMOVED INTEGER, ZSESSIONTYPE INTEGER, ZSPOTLIGHTSTATUS INTEGER, ZUNREADCOUNT INTEGER, ZGROUPINFO INTEGER, ZLASTMESSAGE INTEGER, ZPROPERTIES INTEGER, ZLASTMESSAGEDATE TIMESTAMP, ZLOCATIONSHARINGENDDATE TIMESTAMP, ZCONTACTIDENTIFIER VARCHAR, ZCONTACTJID VARCHAR, ZETAG VARCHAR, ZLASTMESSAGETEXT VARCHAR, ZPARTNERNAME VARCHAR, ZSAVEDINPUT VARCHAR );
    CREATE TABLE ZWAGROUPINFO ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZSTATE INTEGER, ZCHATSESSION INTEGER, ZLASTMESSAGEOWNER INTEGER, ZCREATIONDATE TIMESTAMP, ZSUBJECTTIMESTAMP TIMESTAMP, ZCREATORJID VARCHAR, ZOWNERJID VARCHAR, ZPICTUREID VARCHAR, ZPICTUREPATH VARCHAR, ZSOURCEJID VARCHAR, ZSUBJECTOWNERJID VARCHAR );
    CREATE TABLE ZWAGROUPMEMBER ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCONTACTABID INTEGER, ZISACTIVE INTEGER, ZISADMIN INTEGER, ZSENDERKEYSENT INTEGER, ZCHATSESSION INTEGER, ZRECENTGROUPCHAT INTEGER, ZCONTACTIDENTIFIER VARCHAR, ZCONTACTNAME VARCHAR, ZFIRSTNAME VARCHAR, ZMEMBERJID VARCHAR );
    CREATE TABLE ZWAGROUPMEMBERSCHANGE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCHANGETYPE INTEGER, ZCHANGEDATE TIMESTAMP, ZGROUPJID VARCHAR, ZMEMBERJIDS VARCHAR, ZPHASHBEFORECHANGE VARCHAR );
    CREATE TABLE ZWAMEDIAITEM ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCLOUDSTATUS INTEGER, ZFILESIZE INTEGER, ZMEDIAORIGIN INTEGER, ZMOVIEDURATION INTEGER, ZMESSAGE INTEGER, ZASPECTRATIO FLOAT, ZHACCURACY FLOAT, ZLATITUDE FLOAT, ZLONGITUDE FLOAT, ZMEDIAURLDATE TIMESTAMP, ZAUTHORNAME VARCHAR, ZCOLLECTIONNAME VARCHAR, ZMEDIALOCALPATH VARCHAR, ZMEDIAURL VARCHAR, ZTHUMBNAILLOCALPATH VARCHAR, ZTITLE VARCHAR, ZVCARDNAME VARCHAR, ZVCARDSTRING VARCHAR, ZXMPPTHUMBPATH VARCHAR, ZMEDIAKEY BLOB, ZMETADATA BLOB );
    CREATE TABLE ZWAMESSAGE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCHILDMESSAGESDELIVEREDCOUNT INTEGER, ZCHILDMESSAGESPLAYEDCOUNT INTEGER, ZCHILDMESSAGESREADCOUNT INTEGER, ZDATAITEMVERSION INTEGER, ZDOCID INTEGER, ZENCRETRYCOUNT INTEGER, ZFILTEREDRECIPIENTCOUNT INTEGER, ZFLAGS INTEGER, ZGROUPEVENTTYPE INTEGER, ZISFROMME INTEGER, ZMESSAGEERRORSTATUS INTEGER, ZMESSAGESTATUS INTEGER, ZMESSAGETYPE INTEGER, ZSORT INTEGER, ZSPOTLIGHTSTATUS INTEGER, ZSTARRED INTEGER, ZCHATSESSION INTEGER, ZGROUPMEMBER INTEGER, ZLASTSESSION INTEGER, ZMEDIAITEM INTEGER, ZMESSAGEINFO INTEGER, ZPARENTMESSAGE INTEGER, ZMESSAGEDATE TIMESTAMP, ZSENTDATE TIMESTAMP, ZFROMJID VARCHAR, ZMEDIASECTIONID VARCHAR, ZPHASH VARCHAR, ZPUSHNAME VARCHAR, ZSTANZAID VARCHAR, ZTEXT VARCHAR, ZTOJID VARCHAR );
    CREATE TABLE ZWAMESSAGEDATAITEM ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZINDEX INTEGER, ZOWNSTHUMBNAIL INTEGER, ZTYPE INTEGER, ZMESSAGE INTEGER, ZDATE TIMESTAMP, ZCHATJID VARCHAR, ZCONTENT1 VARCHAR, ZCONTENT2 VARCHAR, ZMATCHEDTEXT VARCHAR, ZSECTIONID VARCHAR, ZSENDERJID VARCHAR, ZSUMMARY VARCHAR, ZTHUMBNAILPATH VARCHAR, ZTITLE VARCHAR );
    CREATE TABLE ZWAMESSAGEINFO ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZMESSAGE INTEGER, ZRECEIPTINFO BLOB );
    CREATE TABLE ZWAPROFILEPICTUREITEM ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZREQUESTDATE TIMESTAMP, ZJID VARCHAR, ZPATH VARCHAR, ZPICTUREID VARCHAR );
    CREATE TABLE ZWAPROFILEPUSHNAME ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZJID VARCHAR, ZPUSHNAME VARCHAR );
    INSERT INTO ZWACHATSESSION (Z_PK, Z_ENT, ZCONTACTJID, ZSESSIONTYPE, ZPARTNERNAME) VALUES (1, 4, '15550001001@s.whatsapp.net', 0, 'Alice');
    INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, ZCHATSESSION, ZISFROMME, ZSTANZAID, ZFROMJID, ZMESSAGETYPE, ZMESSAGEDATE, ZTEXT)
      VALUES (1, 9, 1, 0, 'A1', '15550001001@s.whatsapp.net', 0, 812541600, 'Are you coming?');
    `,
  );
  store(
    'ExtChatDB/ExtChatDatabase.sqlite',
    'CREATE TABLE message_parent_association( stanza_id TEXT NOT NULL, parent_stanza_id TEXT NOT NULL, type INTEGER NOT NULL, sort LONG_INT NOT NULL, chat_jid TEXT NOT NULL, PRIMARY KEY (stanza_id, chat_jid, type) );',
  );
  store(
    'statusDB/Status.sqlite',
    `
    CREATE TABLE status( row_id INTEGER PRIMARY KEY AUTOINCREMENT, sort_id LONG_INT NOT NULL, uuid TEXT NOT NULL, sender_user_jid TEXT NOT NULL, status_info_row_id INTEGER NOT NULL, type INTEGER NOT NULL, timestamp LONG_INT NOT NULL, server_receipt_timestamp LONG_INT, text_data TEXT, state INTEGER NOT NULL, secret BLOB, content_proto BLOB, fp_proto BLOB, origin INTEGER NOT NULL, flags INTEGER NOT NULL, is_archived INTEGER NOT NULL , audience_type INTEGER NOT NULL DEFAULT 0, stanza_xml BLOB, received_timestamp LONG_INT, batch_state INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE status_text( status_row_id INTEGER PRIMARY KEY, url TEXT, page_title TEXT, page_description TEXT, font_style INTEGER, text_color INTEGER, background_color INTEGER, preview_type INTEGER, invite_link_group_type INTEGER, thumbnail BLOB, text_content_proto BLOB );
    CREATE TABLE status_media_link( row_id INTEGER PRIMARY KEY AUTOINCREMENT, status_row_id INTEGER NOT NULL, media_content_row_id INTEGER NOT NULL );
    CREATE TABLE media_content( row_id INTEGER PRIMARY KEY AUTOINCREMENT, state INTEGER NOT NULL, transcoded INTEGER NOT NULL, file_path TEXT, suspicious_content INTEGER NOT NULL, width INTEGER, height INTEGER, file_size INTEGER, file_length INTEGER, media_duration INTEGER, media_key BLOB, media_key_timestamp LONG_INT, partial_media_hash TEXT, partial_media_enc_hash TEXT, file_hash TEXT, enc_file_hash TEXT, direct_path TEXT, static_url TEXT, sidecar BLOB, chunk_lengths BLOB, auto_upload_download INTEGER NOT NULL, media_job_uuid TEXT, mime_type TEXT, gif_attribution INTEGER NOT NULL, trim_from INTEGER, trim_to INTEGER, mute_video INTEGER DEFAULT 0, accessibility_label TEXT, media_transcode_quality INTEGER NOT NULL DEFAULT 0, multicast_id TEXT, media_url TEXT, media_name TEXT, original_file_hash TEXT, media_source_type INTEGER, doodle_id TEXT , media_upload_handle TEXT, smart_thumbnail_ts INTEGER);
    INSERT INTO status (row_id, sort_id, uuid, sender_user_jid, status_info_row_id, type, timestamp, text_data, state, origin, flags, is_archived)
      VALUES (1, 1, 'S-TEXT', '9001@lid', 1, 3, ${Math.floor(Date.now() / 1000) - 978307200 - 3600}, 'Hello', 4, 0, 0, 0);
    `,
  );
}

// One pass of the import the hosts make for a selection, and the loaded
// streams a reader finds in its data.sqlite, by row count.
async function importWhatsApp(
  connector: AppleConnector,
  directory: string,
  scope: ImportScope,
) {
  const { connection } = await connector.connection(directory, {
    connector: connector.name,
    scope,
    includeAttachments: false,
  });
  try {
    await new Pipeline({ connections: [connection] }).run();
  } catch (error) {
    // The stores this container lacks fail their streams; the rest load.
    if (!(error instanceof PipelineError)) throw error;
  }
  using database = new DatabaseSync(join(directory, 'data.sqlite'), {
    readOnly: true,
  });
  return Object.fromEntries(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'raw\\_%' ESCAPE '\\' ORDER BY name",
      )
      .all()
      .map(({ name }) => [
        String(name).slice('raw_'.length),
        database.prepare(`SELECT count(*) AS n FROM "${String(name)}"`).get()
          ?.n,
      ]),
  );
}

test('an import narrowed to a chat loads that chat and what hangs off it, and leaves out statuses and the other streams that belong to no chat', async () => {
  await using home = await mkdtempDisposable(join(tmpdir(), 'whatsapp-home-'));
  whatsappContainer(home.path);
  const connector = await connectorUnder(home.path);

  const everything = await importWhatsApp(
    connector,
    join(home.path, 'all'),
    {},
  );
  const narrowed = await importWhatsApp(
    connector,
    join(home.path, 'narrowed'),
    { collectionIds: ['15550001001@s.whatsapp.net'] },
  );

  assert.equal(everything.statuses, 1);
  assert.deepEqual(narrowed, {
    chatPushConfigs: 0,
    chats: 1,
    groupMembers: 0,
    groupMembersChanges: 0,
    messageAssociations: 0,
    messageDataItems: 0,
    messageReactionCounts: 0,
    messageReactions: 0,
    messageReceipts: 0,
    messages: 1,
  });
});
