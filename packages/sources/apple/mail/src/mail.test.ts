import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import {
  mkdir,
  mkdtempDisposable,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';

import {
  Connection,
  Copy,
  FileRead,
  LocalFiles,
  Pipeline,
  PipelineError,
  type Source,
} from '@workspace/elt';
import { MarkdownDestination } from '@workspace/elt-markdown';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  SQLiteSyncHistory,
  installSQLiteCatalog,
} from '@workspace/elt-sqlite';
import {
  AccountsStore,
  AccountsUnavailableError,
  accountsStorePath,
} from '@workspace/macos-accounts';
import { MacOSDocumentParser } from '@workspace/source-apple-macos/macos-document-parser';

import { AppleMailSource } from './apple-mail-source.ts';
import {
  MailUnavailableError,
  mailDirectory,
  mailVersionDirectory,
} from './mail-store.ts';

const snake = (name: string) =>
  name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

// One Apple source loaded as the hosts load it: every stream incrementally
// into raw_<stream> of one SQLite file, read through its documented
// <snake_stream> view, with files kept beside it.
async function appleImport(source: Source, directory: string) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'data.sqlite');
  const destination = new SQLiteDestination({ path });
  const files = new LocalFiles({ directory: join(directory, 'files') });
  const { streams } = await source.discover();
  const connection = new Connection({
    name: 'apple',
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(directory, 'checkpoints.sqlite'),
    }),
    steps: streams.map(
      (stream) =>
        new Copy(
          stream,
          destination
            .table(
              `raw_${stream.name}`,
              stream.supportsFileTransfer
                ? (columns) => [
                    ...SQLiteColumns.fromSchema(stream.jsonSchema),
                    columns
                      .text('attachmentRef')
                      .from(stream.file.store(files)),
                  ]
                : undefined,
            )
            .withReaderView(snake(stream.name)),
          {
            id: stream.name,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          },
        ),
    ),
  });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  installSQLiteCatalog({ path });
  return {
    load: () => new Pipeline({ history, connections: [connection] }).run(),
    read: (sql: string) => {
      using database = new DatabaseSync(path, { readOnly: true });
      return database.prepare(sql).all();
    },
  };
}

type Archivable =
  | string
  | number
  | boolean
  | readonly Archivable[]
  | { readonly [key: string]: Archivable };

// A synthetic Accounts4.sqlite with the account tables macOS 27's Accounts
// framework writes, as its schema declares them, and values stored as real
// NSKeyedArchiver archives.
class ScratchAccountsStore implements Disposable {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      CREATE TABLE ZACCOUNT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZACTIVE INTEGER, ZAUTHENTICATED INTEGER, ZSUPPORTSAUTHENTICATION INTEGER, ZVISIBLE INTEGER, ZWARMINGUP INTEGER, ZACCOUNTTYPE INTEGER, ZPARENTACCOUNT INTEGER, ZDATE TIMESTAMP, ZLASTCREDENTIALRENEWALREJECTIONDATE TIMESTAMP, ZACCOUNTDESCRIPTION VARCHAR, ZAUTHENTICATIONTYPE VARCHAR, ZCREDENTIALTYPE VARCHAR, ZIDENTIFIER VARCHAR, ZMODIFICATIONID VARCHAR, ZOWNINGBUNDLEID VARCHAR, ZUSERNAME VARCHAR, ZDATACLASSPROPERTIES BLOB );
      CREATE TABLE Z_2ENABLEDDATACLASSES ( Z_2ENABLEDACCOUNTS INTEGER, Z_7ENABLEDDATACLASSES INTEGER, PRIMARY KEY (Z_2ENABLEDACCOUNTS, Z_7ENABLEDDATACLASSES) );
      CREATE TABLE Z_2PROVISIONEDDATACLASSES ( Z_2PROVISIONEDACCOUNTS INTEGER, Z_7PROVISIONEDDATACLASSES INTEGER, PRIMARY KEY (Z_2PROVISIONEDACCOUNTS, Z_7PROVISIONEDDATACLASSES) );
      CREATE TABLE ZACCOUNTPROPERTY ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOWNER INTEGER, ZKEY VARCHAR, ZVALUE BLOB );
      CREATE TABLE ZACCOUNTTYPE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOBSOLETE INTEGER, ZSUPPORTSAUTHENTICATION INTEGER, ZSUPPORTSMULTIPLEACCOUNTS INTEGER, ZVISIBILITY INTEGER, ZACCOUNTTYPEDESCRIPTION VARCHAR, ZCREDENTIALPROTECTIONPOLICY VARCHAR, ZCREDENTIALTYPE VARCHAR, ZIDENTIFIER VARCHAR, ZOWNINGBUNDLEID VARCHAR );
      CREATE TABLE ZDATACLASS ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZNAME BLOB , ZENUMVALUE INTEGER);
    `);
  }

  account(account: {
    readonly pk: number;
    readonly identifier: string;
    readonly type: string;
    readonly parent?: number;
    readonly description?: string;
    readonly username?: string;
    readonly enabled?: readonly string[];
    readonly properties?: { readonly [key: string]: Archivable };
    readonly dataclassProperties?: { readonly [key: string]: Archivable };
  }): void {
    this.#database
      .prepare(
        `INSERT INTO ZACCOUNT (Z_PK, ZACTIVE, ZACCOUNTTYPE, ZPARENTACCOUNT,
           ZACCOUNTDESCRIPTION, ZIDENTIFIER, ZUSERNAME, ZDATACLASSPROPERTIES)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        account.pk,
        this.#row('ZACCOUNTTYPE', 'ZIDENTIFIER', account.type),
        account.parent ?? null,
        account.description ?? null,
        account.identifier,
        account.username ?? null,
        account.dataclassProperties === undefined
          ? null
          : this.#archive(account.dataclassProperties),
      );
    for (const [key, value] of Object.entries(account.properties ?? {}))
      this.#database
        .prepare(
          'INSERT INTO ZACCOUNTPROPERTY (ZOWNER, ZKEY, ZVALUE) VALUES (?, ?, ?)',
        )
        .run(account.pk, key, this.#archive(value));
    for (const name of account.enabled ?? [])
      this.#database
        .prepare('INSERT INTO Z_2ENABLEDDATACLASSES VALUES (?, ?)')
        .run(account.pk, this.#row('ZDATACLASS', 'ZNAME', this.#archive(name)));
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }

  // The primary key of the account type or data class row holding value,
  // inserted on first use.
  #row(table: string, column: string, value: string | Buffer): number {
    const found = this.#database
      .prepare(`SELECT Z_PK FROM ${table} WHERE ${column} = ?`)
      .get(value)?.Z_PK;
    if (found !== undefined) return Number(found);
    return Number(
      this.#database
        .prepare(`INSERT INTO ${table} (${column}) VALUES (?)`)
        .run(value).lastInsertRowid,
    );
  }

  // Writes value as an NSKeyedArchiver XML plist and lets plutil turn it into
  // the binary archive the Accounts framework stores.
  #archive(value: Archivable): Buffer {
    const objects: string[] = ['<string>$null</string>'];
    const classes = new Map<string, number>();
    const uid = (index: number) =>
      `<dict><key>CF$UID</key><integer>${index}</integer></dict>`;
    const escape = (text: string) =>
      text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
    const classOf = (name: string) => {
      const known = classes.get(name);
      if (known !== undefined) return known;
      objects.push(
        `<dict><key>$classname</key><string>${name}</string><key>$classes</key><array><string>${name}</string><string>NSObject</string></array></dict>`,
      );
      classes.set(name, objects.length - 1);
      return objects.length - 1;
    };
    const add = (item: Archivable): number => {
      const index = objects.push('') - 1;
      if (typeof item === 'string')
        objects[index] = `<string>${escape(item)}</string>`;
      else if (typeof item === 'boolean')
        objects[index] = item ? '<true/>' : '<false/>';
      else if (typeof item === 'number')
        objects[index] = Number.isInteger(item)
          ? `<integer>${item}</integer>`
          : `<real>${item}</real>`;
      else if (Array.isArray(item)) {
        const members = item.map(add);
        objects[index] =
          `<dict><key>NS.objects</key><array>${members.map(uid).join('')}</array><key>$class</key>${uid(classOf('NSArray'))}</dict>`;
      } else {
        const entries = Object.entries(item);
        const keys = entries.map(([key]) => add(key));
        const values = entries.map(([, member]) => add(member));
        objects[index] =
          `<dict><key>NS.keys</key><array>${keys.map(uid).join('')}</array><key>NS.objects</key><array>${values.map(uid).join('')}</array><key>$class</key>${uid(classOf('NSDictionary'))}</dict>`;
      }
      return index;
    };
    const root = add(value);
    return execFileSync(
      '/usr/bin/plutil',
      ['-convert', 'binary1', '-o', '-', '-'],
      {
        input: `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>$archiver</key><string>NSKeyedArchiver</string>
<key>$version</key><integer>100000</integer>
<key>$top</key><dict><key>root</key>${uid(root)}</dict>
<key>$objects</key><array>${objects.join('')}</array></dict></plist>`,
      },
    );
  }
}

// The system Accounts store behind the fixture's imap://ACCOUNT mailbox, laid
// out as on macOS 27: an iCloud account whose IMAP and SMTP children hold
// Mail's own settings, and a calendar account under it that owns no mailbox.
// LOCAL, the On My Mac host, has no account here, so its URL describes it.
function scratchAccounts(path: string): AccountsStore {
  using store = new ScratchAccountsStore(path);
  store.account({
    pk: 1,
    identifier: 'ICLOUD',
    type: 'com.apple.account.AppleAccount',
    description: 'iCloud',
    username: 'user1@example.com',
    enabled: ['com.apple.Dataclass.Mail', 'com.apple.Dataclass.Calendars'],
    properties: {
      ACPropertyFullName: 'Synthetic User',
      appleIDAliases: ['user1@example.com', 'alias1@example.com'],
    },
    dataclassProperties: {
      'com.apple.Dataclass.Mail': {
        EmailAddress: 'user1@icloud.example',
        imapHostname: 'imap1.example.com',
        imapPort: 143,
        imapRequiresSSL: false,
        smtpHostname: 'smtp1.example.com',
        smtpPort: 587,
        smtpRequiresSSL: true,
      },
    },
  });
  // Its own port and TLS setting win over the parent's IMAP settings.
  store.account({
    pk: 2,
    identifier: 'ACCOUNT',
    type: 'com.apple.account.IMAP',
    parent: 1,
    properties: {
      SendingAccountIdentifier: 'SMTP',
      PortNumber: 993,
      SSLIsDirect: true,
      EmailAliases: [
        {
          DisplayName: 'Synthetic User',
          IsEnabled: true,
          EmailAddresses: ['user1@icloud.example', 'user1@alias.example'],
          IsPrimary: true,
        },
      ],
    },
  });
  store.account({
    pk: 3,
    identifier: 'SMTP',
    type: 'com.apple.account.SMTP',
    parent: 1,
    properties: {
      IdentityEmailAddress: 'user1@icloud.example',
      SSLIsDirect: false,
    },
  });
  store.account({
    pk: 4,
    identifier: 'CALENDAR',
    type: 'com.apple.account.CalDAV',
    parent: 1,
    description: 'Synthetic calendars',
    enabled: ['com.apple.Dataclass.Calendars'],
  });
  return new AccountsStore(path);
}

const byId = (a: { id: unknown }, b: { id: unknown }) =>
  String(a.id) < String(b.id) ? -1 : 1;
// What a reader sees for the fixture under root: the IMAP account named and
// addressed through its iCloud parent, and the On My Mac host. The calendar
// account owns no mailbox, so it is not a Mail account.
function expectedAccounts(root: string) {
  return [
    {
      id: 'ACCOUNT',
      properties: {
        id: 'ACCOUNT',
        name: 'iCloud',
        type: 'com.apple.account.IMAP',
        parentType: 'com.apple.account.AppleAccount',
        enabled: true,
        emailAddresses: [
          'user1@icloud.example',
          'user1@alias.example',
          'user1@example.com',
          'alias1@example.com',
        ],
        fullName: 'Synthetic User',
        userName: 'user1@example.com',
        serverName: 'imap1.example.com',
        port: 993,
        usesSsl: true,
        directory: join(root, 'V10/ACCOUNT'),
        sendingServerId: 'SMTP',
      },
    },
    {
      id: 'LOCAL',
      properties: {
        id: 'LOCAL',
        name: 'On My Mac',
        type: 'local',
        parentType: null,
        enabled: null,
        emailAddresses: [],
        fullName: null,
        userName: null,
        serverName: null,
        port: null,
        usesSsl: null,
        directory: join(root, 'V10/LOCAL'),
        sendingServerId: null,
      },
    },
  ];
}
// iCloud's SMTP server takes its host, port and TLS from the parent's Mail
// settings; its own SSLIsDirect false means STARTTLS, not that TLS is off.
const expectedSmtpServers = [
  {
    id: 'SMTP',
    properties: {
      id: 'SMTP',
      name: 'iCloud',
      userName: 'user1@icloud.example',
      serverName: 'smtp1.example.com',
      port: 587,
      usesSsl: true,
      enabled: true,
    },
  },
];
// Account and SMTP rows as a consumer reads them: properties parsed from JSON.
function parsedProperties(found: Record<string, unknown>[]) {
  return found
    .map(({ id, properties }) => ({
      id,
      properties: JSON.parse(String(properties)),
    }))
    .sort(byId);
}

// Mail 16.0 on macOS 26.6.2: schema only, with no personal records or triggers.
const schema = `PRAGMA journal_mode = WAL;
CREATE TABLE messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message_id INTEGER NOT NULL DEFAULT 0,
global_message_id INTEGER NOT NULL,
remote_id INTEGER,
document_id TEXT COLLATE BINARY,
sender INTEGER,
subject_prefix TEXT COLLATE BINARY,
subject INTEGER NOT NULL,
summary INTEGER,
date_sent INTEGER,
date_received INTEGER,
mailbox INTEGER NOT NULL,
remote_mailbox INTEGER,
flags INTEGER NOT NULL DEFAULT 0,
read INTEGER NOT NULL DEFAULT 0,
flagged INTEGER NOT NULL DEFAULT 0,
deleted INTEGER NOT NULL DEFAULT 0,
size INTEGER NOT NULL DEFAULT 0,
conversation_id INTEGER NOT NULL DEFAULT 0,
date_last_viewed INTEGER,
list_id_hash INTEGER,
unsubscribe_type INTEGER,
searchable_message INTEGER,
brand_indicator INTEGER,
display_date INTEGER,
flag_color INTEGER,
color TEXT COLLATE BINARY,
type INTEGER,
fuzzy_ancestor INTEGER,
automated_conversation INTEGER DEFAULT 0,
root_status INTEGER DEFAULT -1, is_urgent INTEGER NOT NULL DEFAULT 0);
CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
url TEXT COLLATE BINARY NOT NULL,
total_count INTEGER NOT NULL DEFAULT 0,
unread_count INTEGER NOT NULL DEFAULT 0,
deleted_count INTEGER NOT NULL DEFAULT 0,
unseen_count INTEGER NOT NULL DEFAULT 0,
unread_count_adjusted_for_duplicates INTEGER NOT NULL DEFAULT 0,
change_identifier TEXT COLLATE BINARY,
source INTEGER,
alleged_change_identifier TEXT COLLATE BINARY,
UNIQUE(url) ON CONFLICT ABORT);
CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
address TEXT COLLATE NOCASE NOT NULL,
comment TEXT COLLATE BINARY NOT NULL,
UNIQUE(address, comment) ON CONFLICT ABORT);
CREATE TABLE recipients (ROWID INTEGER PRIMARY KEY,
message INTEGER NOT NULL,
address INTEGER NOT NULL,
type INTEGER,
position INTEGER,
UNIQUE(message, type, position) ON CONFLICT ABORT);
CREATE TABLE attachments (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message INTEGER NOT NULL REFERENCES messages(ROWID) ON DELETE CASCADE,
attachment_id TEXT COLLATE BINARY,
name TEXT COLLATE BINARY,
UNIQUE(message, attachment_id) ON CONFLICT ABORT);
CREATE TABLE labels (message_id INTEGER REFERENCES messages(ROWID) ON DELETE CASCADE, mailbox_id INTEGER REFERENCES mailboxes(ROWID) ON DELETE CASCADE, PRIMARY KEY(message_id, mailbox_id)) WITHOUT ROWID;
CREATE TABLE server_messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message INTEGER REFERENCES messages(ROWID) ON DELETE SET NULL,
mailbox INTEGER NOT NULL REFERENCES mailboxes(ROWID) ON DELETE CASCADE,
sequence_identifier INTEGER,
read INTEGER NOT NULL,
deleted INTEGER NOT NULL,
replied INTEGER NOT NULL,
flagged INTEGER NOT NULL,
draft INTEGER NOT NULL,
forwarded INTEGER NOT NULL,
redirected INTEGER NOT NULL,
junk_level_set_by_user INTEGER NOT NULL,
junk_level INTEGER NOT NULL,
flag_color INTEGER NOT NULL,
remote_id INTEGER NOT NULL,
UNIQUE(mailbox, remote_id) ON CONFLICT ABORT);
CREATE TABLE server_labels (server_message INTEGER REFERENCES server_messages(ROWID) ON DELETE CASCADE,
label INTEGER REFERENCES mailboxes(ROWID) ON DELETE CASCADE,
PRIMARY KEY(server_message, label)) WITHOUT ROWID;
CREATE TABLE conversations (conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
flags INTEGER NOT NULL DEFAULT 0,
sync_key TEXT COLLATE BINARY);
CREATE TABLE conversation_id_message_id (conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE ON UPDATE CASCADE,
message_id INTEGER NOT NULL DEFAULT 0,
date_sent INTEGER NOT NULL DEFAULT 0,
PRIMARY KEY(conversation_id, message_id)) WITHOUT ROWID;
CREATE TABLE message_references (ROWID INTEGER PRIMARY KEY,
message INTEGER NOT NULL REFERENCES messages(ROWID) ON DELETE CASCADE,
reference INTEGER NOT NULL DEFAULT 0,
is_originator INTEGER NOT NULL DEFAULT 0);
CREATE TABLE message_global_data (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message_id INTEGER,
follow_up_start_date INTEGER,
follow_up_end_date INTEGER,
follow_up_jsonstringformodelevaluationforsuggestions TEXT COLLATE BINARY,
read_later_date INTEGER,
send_later_date INTEGER,
validation_state INTEGER NOT NULL DEFAULT 0,
model_category INTEGER,
model_subcategory INTEGER,
category_model_version INTEGER,
category_is_temporary INTEGER,
model_analytics TEXT COLLATE BINARY,
model_high_impact INTEGER NOT NULL DEFAULT 0,
generated_summary INTEGER,
urgent INTEGER, message_id_header TEXT COLLATE BINARY, due_by INTEGER,
UNIQUE(message_id) ON CONFLICT ABORT);
CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
subject TEXT COLLATE RTRIM NOT NULL,
UNIQUE(subject) ON CONFLICT ABORT);
CREATE TABLE summaries (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
summary TEXT COLLATE RTRIM NOT NULL,
UNIQUE(summary) ON CONFLICT ABORT);
CREATE TABLE generated_summaries (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
summary BLOB NOT NULL,
status INTEGER NOT NULL DEFAULT 0);
CREATE TABLE message_metadata (message_id INTEGER PRIMARY KEY,
timestamp INTEGER NOT NULL,
json_values TEXT COLLATE BINARY NOT NULL);
CREATE TABLE data_detection_results (ROWID INTEGER PRIMARY KEY,
global_message_id INTEGER NOT NULL,
category TEXT COLLATE BINARY NOT NULL,
value TEXT COLLATE BINARY NOT NULL,
UNIQUE(global_message_id, category, value) ON CONFLICT ABORT);
CREATE TABLE rich_links (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
title TEXT COLLATE BINARY,
url TEXT COLLATE BINARY NOT NULL,
hash TEXT COLLATE BINARY NOT NULL,
UNIQUE(hash) ON CONFLICT ABORT);
CREATE TABLE message_rich_links (global_message_id INTEGER NOT NULL REFERENCES message_global_data(ROWID) ON DELETE CASCADE,
rich_link INTEGER NOT NULL REFERENCES rich_links(ROWID) ON DELETE CASCADE,
PRIMARY KEY(global_message_id, rich_link)) WITHOUT ROWID;
CREATE TABLE protected_message_data (ROWID INTEGER PRIMARY KEY,
data TEXT COLLATE BINARY);
CREATE TABLE brand_indicators (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
url TEXT COLLATE BINARY NOT NULL,
indicator BLOB,
indicator_hash TEXT COLLATE BINARY,
hash_algorithm TEXT COLLATE BINARY,
UNIQUE(url) ON CONFLICT ABORT);
CREATE TABLE brand_indicator_evidence (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
brand_indicator INTEGER NOT NULL REFERENCES brand_indicators(ROWID) ON DELETE CASCADE ON UPDATE CASCADE,
url TEXT COLLATE BINARY NOT NULL,
evidence BLOB,
unverified_messages TEXT COLLATE BINARY,
UNIQUE(brand_indicator, url) ON CONFLICT ABORT);
CREATE TABLE address_metadata (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
address TEXT COLLATE NOCASE NOT NULL,
smime_capabilities TEXT COLLATE NOCASE NOT NULL,
smime_capabilities_date INTEGER NOT NULL,
UNIQUE(address) ON CONFLICT ABORT);
CREATE TABLE businesses (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
address_comment TEXT COLLATE NOCASE,
domain TEXT COLLATE NOCASE,
brand_id INTEGER,
localized_brand_name TEXT,
UNIQUE(address_comment, domain) ON CONFLICT ABORT,
UNIQUE(brand_id) ON CONFLICT ABORT,
CHECK(((address_comment IS NOT NULL AND domain IS NOT NULL AND brand_id IS NULL AND localized_brand_name IS NULL) OR (address_comment IS NULL AND domain IS NULL AND brand_id IS NOT NULL AND localized_brand_name IS NOT NULL))));
CREATE TABLE business_addresses (ROWID INTEGER PRIMARY KEY,
address INTEGER NOT NULL,
business INTEGER NOT NULL,
category INTEGER,
last_modified INTEGER,
last_bcs_sync INTEGER,
UNIQUE(address) ON CONFLICT ABORT);
CREATE TABLE business_categories (ROWID INTEGER PRIMARY KEY,
business INTEGER NOT NULL,
category INTEGER NOT NULL,
UNIQUE(business) ON CONFLICT ABORT);
CREATE TABLE senders (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
contact_identifier TEXT COLLATE BINARY,
bucket INTEGER NOT NULL DEFAULT 0,
user_initiated INTEGER NOT NULL DEFAULT 1,
UNIQUE(contact_identifier) ON CONFLICT ABORT);
CREATE TABLE sender_addresses (address INTEGER PRIMARY KEY,
sender INTEGER NOT NULL REFERENCES senders(ROWID) ON DELETE CASCADE);
CREATE TABLE events (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES messages(ROWID) ON DELETE CASCADE, start_date INTEGER, end_date INTEGER, location TEXT, out_of_date INTEGER DEFAULT 0, processed INTEGER DEFAULT 0, is_all_day INTEGER DEFAULT 0, associated_id_string TEXT, original_receiving_account TEXT, ical_uid TEXT, is_response_requested INTEGER DEFAULT 0);`;

const xml = (value: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">${value}</plist>`;
const digest = (value: Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const embedded =
  'From: nested@example.test\r\nSubject: nested\r\n\r\nForwarded body\r\n';
const mime = [
  'From: Example <sender@example.test>',
  'To: reader@example.test',
  'Message-ID: <fixture@example.test>',
  'Subject: =?UTF-8?B?SGVsbG8g8J+MjQ==?=',
  'Received: first',
  'Received: second',
  'X-Empty:',
  'X-Unicode: مرحبا',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  '--outer',
  'Content-Type: multipart/alternative; boundary="inner"',
  '',
  '--inner',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Hello =F0=9F=8C=8D',
  '--inner',
  'Content-Type: text/html; charset=UTF-8',
  '',
  '<p>Hello 🌍</p>',
  '--inner--',
  '--outer',
  'Content-Type: application/pdf',
  'Content-Disposition: attachment; filename="detached.pdf"',
  'X-Apple-Content-Length: 12',
  '',
  '--outer',
  'Content-Type: application/zip',
  'Content-Disposition: attachment; filename="missing.zip"',
  'X-Apple-Content-Length: 4',
  '',
  '--outer',
  'Content-Type: message/rfc822',
  'Content-Disposition: attachment; filename="forwarded.eml"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from(embedded).toString('base64'),
  '--outer',
  'Content-Type: image/png',
  'Content-Disposition: inline; filename="tiny.png"',
  'Content-ID: <image>',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from([0, 1, 2, 255]).toString('base64'),
  '--outer--',
  '',
].join('\r\n');
const emlx = Buffer.from(
  `${Buffer.byteLength(mime)}      \n${mime}${xml('<dict><key>flags</key><integer>1</integer></dict>')}`,
);

async function fixture(root: string) {
  const data = join(root, 'V10/ACCOUNT/Inbox.mbox/UUID/Data');
  await mkdir(join(data, 'Messages'), { recursive: true });
  await mkdir(join(root, 'V10/MailData/Signatures'), { recursive: true });
  await mkdir(join(data, 'Attachments/1/2'), { recursive: true });
  await writeFile(
    join(root, 'PersistenceInfo.plist'),
    xml(
      '<dict><key>LastUsedVersionDirectoryName</key><string>V10</string></dict>',
    ),
  );
  await writeFile(join(data, 'Messages/1.partial.emlx'), emlx);
  await writeFile(
    join(data, 'Messages/999.emlx'),
    'orphan file is not a live message',
  );
  await writeFile(join(data, 'Attachments/1/2/detached.pdf'), '%PDF-fixture');
  await writeFile(
    join(root, 'V10/ACCOUNT/Inbox.mbox/Info.plist'),
    xml('<dict><key>MailboxID</key><string>INBOX</string></dict>'),
  );
  await writeFile(
    join(root, 'V10/MailData/SyncedRules.plist'),
    xml(
      '<array><dict><key>RuleId</key><string>rule</string><key>RuleName</key><string>Example</string><key>Criteria</key><array><dict><key>Header</key><string>Subject</string><key>Qualifier</key><string>Contains</string><key>Expression</key><string>hello</string></dict></array></dict></array>',
    ),
  );
  await writeFile(
    join(root, 'V10/MailData/RulesActiveState.plist'),
    xml('<dict><key>rule</key><true/></dict>'),
  );
  await writeFile(
    join(root, 'V10/MailData/SyncedSmartMailboxes.plist'),
    xml(
      '<array><dict><key>MailboxID</key><string>parent</string><key>MailboxChildren</key><array><dict><key>MailboxID</key><string>smart</string><key>MailboxCriteria</key><array><dict><key>Header</key><string>From</string></dict></array></dict></array></dict></array>',
    ),
  );
  await writeFile(
    join(root, 'V10/MailData/Signatures/example.mailsignature'),
    'Content-Type: text/html\r\n\r\n<b>Signature</b>',
  );
  using db = new DatabaseSync(join(root, 'V10/MailData/Envelope Index'));
  db.exec(schema);
  db.exec(`
    INSERT INTO mailboxes(ROWID,url) VALUES(1,'imap://ACCOUNT/INBOX'),(2,'local://LOCAL/Archive');
    INSERT INTO addresses VALUES(1,'sender@example.test','Example');
    INSERT INTO subjects VALUES(1,'Hello 🌍');
    INSERT INTO summaries VALUES(1,'Hello');
    INSERT INTO message_global_data(ROWID,message_id,message_id_header) VALUES(1,9223372036854775800,'<fixture@example.test>');
    INSERT INTO messages(ROWID,message_id,global_message_id,subject,summary,mailbox,sender,date_sent,date_received,list_id_hash) VALUES(1,9223372036854775800,1,1,1,1,1,1735787045,1735787046,-9223372036854775800),(2,2,1,1,1,1,1,NULL,NULL,NULL);
    UPDATE messages SET document_id=X'0102' WHERE ROWID=1;
    INSERT INTO recipients VALUES(1,1,1,0,0),(2,999,1,0,0);
    INSERT INTO attachments VALUES(1,1,'2','detached.pdf'),(2,1,'3','missing.zip'),(3,2,'1','not-downloaded.txt');
    INSERT INTO labels VALUES(1,1),(1,2);
    INSERT INTO conversations VALUES(1,0,'sync');
    INSERT INTO conversation_id_message_id VALUES(1,9223372036854775800,1735787045);
    INSERT INTO message_references VALUES(1,1,-9223372036854775800,0);
    INSERT INTO generated_summaries VALUES(1,X'010203',0);
    INSERT INTO message_metadata VALUES(1,123,'{}');
    INSERT INTO data_detection_results VALUES(1,1,'url','https://example.test');
    INSERT INTO rich_links VALUES(1,'Example','https://example.test','hash');
    INSERT INTO message_rich_links VALUES(1,1);
    INSERT INTO protected_message_data VALUES(1,'native payload');
    INSERT INTO brand_indicators VALUES(1,'https://example.test/logo',X'0506','digest','sha256');
    INSERT INTO brand_indicator_evidence VALUES(1,1,'https://example.test/cert',X'0708',NULL);
    INSERT INTO address_metadata VALUES(1,'sender@example.test','native',123);
    INSERT INTO businesses VALUES(1,NULL,NULL,9223372036854775800,'Example');
    INSERT INTO business_addresses VALUES(1,1,1,3,123,1735787045.125);
    INSERT INTO business_categories VALUES(1,1,3);
    INSERT INTO senders VALUES(1,'contact',0,1);
    INSERT INTO sender_addresses VALUES(1,1);
    INSERT INTO events(ROWID,message_id,start_date) VALUES(1,1,123);
    INSERT INTO server_messages VALUES(1,1,1,1,0,0,0,0,0,0,0,0,0,0,42);
    INSERT INTO server_labels VALUES(1,1);
  `);
  return {
    data,
    root,
    index: join(root, 'V10/MailData/Envelope Index'),
    accounts: scratchAccounts(join(root, 'Accounts4.sqlite')),
  };
}

function rows(path: string, sql: string) {
  using db = new DatabaseSync(path, { readOnly: true });
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}
function bytes(path: string, table: string, file: unknown) {
  return Buffer.concat(
    rows(
      path,
      `SELECT bytes FROM "_elt_files_${table}_bytes" WHERE file = ${Number(file)} ORDER BY n`,
    ).map((row) => {
      assert.ok(row.bytes instanceof Uint8Array);
      return row.bytes;
    }),
  );
}
async function pipeline(source: AppleMailSource, directory: string) {
  const destination = new SQLiteDestination({
    path: join(directory, 'out.sqlite'),
  });
  const { streams } = await source.discover();
  return new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(directory, 'state.sqlite'),
        }),
        steps: streams.map(
          (stream) =>
            new Copy(
              stream,
              stream.supportsFileTransfer
                ? destination.table(stream.name, (columns) => [
                    ...SQLiteColumns.fromSchema(stream.jsonSchema),
                    columns.blob('bytes').from(stream.file),
                  ])
                : destination.table(stream.name),
              {
                id: stream.name,
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
              },
            ),
        ),
      }),
    ],
  });
}

test('Mail scope filters dates, message ownership and MIME before copying files and checkpoints', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'mail-scope-'));
  const input = await fixture(scratch.path);
  const source = new AppleMailSource({
    path: scratch.path,
    accounts: input.accounts,
    scope: {
      collectionIds: ['1'],
      startAt: '2025-01-01T00:00:00.000Z',
      endAt: '2025-02-01T00:00:00.000Z',
    },
  });
  const run = await pipeline(source, scratch.path);
  await run.run();
  const output = join(scratch.path, 'out.sqlite');
  assert.deepEqual(rows(output, 'SELECT id FROM messages'), [{ id: '1' }]);
  assert.deepEqual(rows(output, 'SELECT DISTINCT messageId FROM attachments'), [
    { messageId: '1' },
  ]);
  assert.deepEqual(
    rows(output, 'SELECT DISTINCT messageId FROM messageParts'),
    [{ messageId: '1' }],
  );
  assert.deepEqual(
    rows(output, 'SELECT DISTINCT messageId FROM messageHeaders'),
    [{ messageId: '1' }],
  );
  assert.deepEqual(rows(output, 'SELECT id FROM recipients'), [{ id: '1' }]);
  assert.deepEqual(rows(output, 'SELECT messageId FROM conversationMessages'), [
    { messageId: '9223372036854775800' },
  ]);
  assert.deepEqual(rows(output, 'SELECT * FROM messageMetadata'), []);
  // A collection scope keeps every account; SMTP servers have no proven
  // owner, so Mail's servers stay out of a scoped import.
  assert.deepEqual(
    parsedProperties(rows(output, 'SELECT id, properties FROM accounts')),
    expectedAccounts(scratch.path),
  );
  assert.deepEqual(rows(output, 'SELECT * FROM smtpServers'), []);
  const saved = JSON.stringify(
    rows(join(scratch.path, 'state.sqlite'), 'SELECT state FROM checkpoints'),
  );
  assert.ok(!saved.includes('not-downloaded.txt'));
  using native = new DatabaseSync(input.index);
  native.exec('UPDATE messages SET date_received=0,date_sent=0 WHERE ROWID=1');
  await run.run();
  assert.deepEqual(rows(output, 'SELECT id FROM messages'), []);
  assert.deepEqual(rows(output, 'SELECT messageId FROM attachments'), []);
  assert.deepEqual(rows(output, 'SELECT messageId FROM messageParts'), []);
  assert.deepEqual(rows(output, 'SELECT messageId FROM messageHeaders'), []);
});

test('Mail exports the native store, MIME, detached files and unavailable metadata; snapshots update and delete', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-mail-'));
  const store = await fixture(join(dir.path, 'Mail'));
  const source = new AppleMailSource({
    path: store.root,
    accounts: store.accounts,
  });
  const run = await pipeline(source, dir.path);
  const out = join(dir.path, 'out.sqlite');
  const first = await run.run();
  assert.equal(first.length, 42);
  assert.ok(first.every((result) => result.count > 0));
  assert.equal(
    rows(out, 'SELECT messageId FROM messages WHERE id=1')[0]?.messageId,
    '9223372036854775800',
  );
  assert.equal(
    rows(out, 'SELECT listIdHash FROM messages WHERE id=1')[0]?.listIdHash,
    '-9223372036854775800',
  );
  assert.equal(
    rows(out, 'SELECT dateSent FROM messages WHERE id=1')[0]?.dateSent,
    '2025-01-02T03:04:05.000Z',
  );
  assert.equal(
    rows(out, 'SELECT lastBcsSync FROM businessAddresses')[0]?.lastBcsSync,
    '2025-01-02T03:04:05.125Z',
  );
  assert.equal(
    rows(out, 'SELECT count(*) AS n FROM messageMailboxes')[0]?.n,
    2,
  );
  assert.equal(rows(out, 'SELECT count(*) AS n FROM recipients')[0]?.n, 2);
  assert.deepEqual(
    rows(
      out,
      "SELECT value FROM messageHeaders WHERE name='received' ORDER BY position",
    ),
    [{ value: 'first' }, { value: 'second' }],
  );
  assert.equal(
    rows(out, "SELECT value FROM messageHeaders WHERE name='subject'")[0]
      ?.value,
    'Hello 🌍',
  );
  assert.match(
    String(
      rows(out, "SELECT text FROM messageParts WHERE partId='1.1'")[0]?.text,
    ),
    /Hello 🌍/,
  );
  assert.deepEqual(
    parsedProperties(rows(out, 'SELECT id, properties FROM accounts')),
    expectedAccounts(store.root),
  );
  assert.deepEqual(
    parsedProperties(rows(out, 'SELECT id, properties FROM smtpServers')),
    expectedSmtpServers,
  );
  assert.equal(rows(out, 'SELECT enabled FROM rules')[0]?.enabled, 1);
  assert.equal(
    rows(out, "SELECT parentId FROM smartMailboxes WHERE id='smart'")[0]
      ?.parentId,
    'parent',
  );
  assert.equal(
    rows(out, 'SELECT summaryBase64 FROM generatedSummaries')[0]?.summaryBase64,
    'AQID',
  );
  const attachments = rows(
    out,
    'SELECT * FROM attachments ORDER BY messageId,partId',
  );
  assert.equal(attachments.length, 5);
  assert.equal(attachments[0]?.sha256, digest(Buffer.from('%PDF-fixture')));
  assert.equal(
    bytes(out, 'attachments', attachments[0]?.bytes).toString(),
    '%PDF-fixture',
  );
  assert.equal(attachments[1]?.availableLocally, 0);
  assert.equal(attachments[1]?.bytes, null);
  assert.equal(
    bytes(out, 'attachments', attachments[2]?.bytes).toString(),
    embedded,
  );
  assert.deepEqual(
    bytes(out, 'attachments', attachments[3]?.bytes),
    Buffer.from([0, 1, 2, 255]),
  );
  assert.equal(attachments[4]?.availableLocally, 0);
  const original = rows(out, 'SELECT * FROM messageFiles WHERE messageId=1')[0];
  assert.deepEqual(bytes(out, 'messageFiles', original?.bytes), emlx);
  assert.equal(
    rows(out, 'SELECT availableLocally FROM messageFiles WHERE messageId=2')[0]
      ?.availableLocally,
    0,
  );
  assert.ok(
    (await run.run()).every(
      (result) => result.count === 0 && result.deleted === 0,
    ),
  );

  using upstream = new DatabaseSync(store.index);
  upstream.exec(
    'UPDATE messages SET read=1 WHERE ROWID=1; DELETE FROM labels WHERE mailbox_id=2',
  );
  await writeFile(
    join(store.data, 'Attachments/1/2/detached.pdf'),
    '%PDF-updated',
  );
  await mkdir(join(store.data, 'Attachments/1/3'), { recursive: true });
  await writeFile(
    join(store.data, 'Attachments/1/3/missing.zip'),
    Buffer.from([1, 2, 3, 4]),
  );
  const downloaded =
    'Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="not-downloaded.txt"\r\n\r\ndownloaded';
  await writeFile(
    join(store.data, 'Messages/2.emlx'),
    `${Buffer.byteLength(downloaded)}\n${downloaded}`,
  );
  const second = await run.run();
  assert.equal(second.find((x) => x.copy.from === source.messages)?.count, 1);
  assert.equal(
    second.find((x) => x.copy.from === source.attachments)?.count,
    3,
  );
  assert.equal(
    second.find((x) => x.copy.from === source.messageMailboxes)?.deleted,
    1,
  );
  assert.equal(
    rows(out, "SELECT availableLocally FROM attachments WHERE partId='3'")[0]
      ?.availableLocally,
    1,
  );
  assert.equal(
    bytes(
      out,
      'attachments',
      rows(out, "SELECT bytes FROM attachments WHERE partId='2'")[0]?.bytes,
    ).toString(),
    '%PDF-updated',
  );
  assert.equal(
    rows(
      out,
      "SELECT availableLocally FROM attachments WHERE messageId='2' AND partId='1'",
    )[0]?.availableLocally,
    1,
  );
  assert.equal(
    rows(out, "SELECT count(*) AS n FROM attachments WHERE messageId='2'")[0]
      ?.n,
    1,
  );
  upstream.exec(
    'DELETE FROM messages WHERE ROWID=1; DELETE FROM attachments WHERE message=1; DELETE FROM labels WHERE message_id=1',
  );
  const third = await run.run();
  assert.equal(third.find((x) => x.copy.from === source.messages)?.deleted, 1);
  assert.equal(
    third.find((x) => x.copy.from === source.attachments)?.deleted,
    4,
  );
  assert.equal(
    third.find((x) => x.copy.from === source.messageParts)?.deleted,
    8,
  );
  assert.ok(
    (await run.run()).every(
      (result) => result.count === 0 && result.deleted === 0,
    ),
  );
});

test('Mail message streams re-read only messages whose files or index attachment rows changed', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-mail-groups-'));
  const store = await fixture(join(dir.path, 'Mail'));
  const source = new AppleMailSource({
    path: store.root,
    accounts: store.accounts,
  });
  const run = await pipeline(source, dir.path);
  const out = join(dir.path, 'out.sqlite');
  const changed = async () =>
    Object.fromEntries(
      (await run.run())
        .filter(({ count, deleted }) => count > 0 || deleted > 0)
        .map(({ copy, count, deleted }) => [
          copy.from.name,
          { count, deleted },
        ]),
    );
  // Re-reading an unchanged message would load identical records, so the
  // outcomes cannot show the skip. The saved group fingerprints at least show
  // that an unchanged message's inputs keep the same identity between runs.
  const groups = () =>
    Object.fromEntries(
      rows(
        join(dir.path, 'state.sqlite'),
        "SELECT id, state FROM checkpoints WHERE id IN ('messageFiles','messageHeaders','messageParts','attachments') ORDER BY id",
      ).map(({ id, state }) => [id, JSON.parse(String(state)).groups]),
    );
  await run.run();
  const saved = groups();
  assert.deepEqual(Object.keys(saved.messageHeaders), ['1']);
  assert.deepEqual(Object.keys(saved.messageFiles), ['1', '2']);
  // Message 2 has no file yet; its indexed attachment is still a group.
  assert.deepEqual(Object.keys(saved.attachments), ['1', '2']);

  assert.deepEqual(await changed(), {});
  assert.deepEqual(groups(), saved);

  // An index-only attachment renamed in the index reloads that row alone,
  // beside the index table's own row.
  using upstream = new DatabaseSync(store.index);
  upstream.exec("UPDATE attachments SET name='renamed.txt' WHERE message=2");
  assert.deepEqual(await changed(), {
    indexedAttachments: { count: 1, deleted: 0 },
    attachments: { count: 1, deleted: 0 },
  });
  assert.deepEqual(
    rows(out, "SELECT filename FROM attachments WHERE messageId='2'"),
    [{ filename: 'renamed.txt' }],
  );
  assert.equal(
    groups().messageHeaders['1'].fingerprint,
    saved.messageHeaders['1'].fingerprint,
  );

  // A partial download completed under the full name is read again: the
  // file row changes, and identical MIME content loads nothing.
  await rename(
    join(store.data, 'Messages/1.partial.emlx'),
    join(store.data, 'Messages/1.emlx'),
  );
  assert.deepEqual(await changed(), { messageFiles: { count: 1, deleted: 0 } });
  assert.deepEqual(
    rows(out, "SELECT partial FROM messageFiles WHERE messageId='1'"),
    [{ partial: 0 }],
  );

  // New bytes in the same file are read again.
  const edited = mime.replace('Received: first', 'Received: edited');
  await writeFile(
    join(store.data, 'Messages/1.emlx'),
    `${Buffer.byteLength(edited)}\n${edited}`,
  );
  const edit = await changed();
  assert.deepEqual(Object.keys(edit).sort(), [
    'messageFiles',
    'messageHeaders',
  ]);
  assert.match(
    String(
      rows(
        out,
        "SELECT value FROM messageHeaders WHERE name='received' ORDER BY position",
      )[0]?.value,
    ),
    /^edited$/,
  );
  assert.deepEqual(await changed(), {});
});

test('Mail failures keep stored rows and checkpoints; absent stores and unknown schemas fail explicitly', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-mail-errors-'));
  const store = await fixture(join(dir.path, 'Mail'));
  const source = new AppleMailSource({
    path: store.root,
    accounts: store.accounts,
  });
  const run = await pipeline(source, dir.path);
  await run.run();
  const before = rows(
    join(dir.path, 'state.sqlite'),
    "SELECT * FROM checkpoints WHERE id='attachments'",
  );
  await writeFile(
    join(store.data, 'Messages/1.partial.emlx'),
    '99999\ntruncated',
  );
  await assert.rejects(
    run.run(),
    (error) =>
      error instanceof PipelineError &&
      error.results.some(
        (x) =>
          x.copy.from === source.attachments &&
          x.failures.some(
            (f) =>
              f.error instanceof Error && f.error.name === 'MailSchemaError',
          ),
      ),
  );
  assert.equal(
    rows(
      join(dir.path, 'out.sqlite'),
      'SELECT count(*) AS n FROM attachments',
    )[0]?.n,
    5,
  );
  // Checkpoints for the failed MIME streams are unchanged even if unrelated metadata commits.
  assert.deepEqual(
    rows(
      join(dir.path, 'state.sqlite'),
      "SELECT * FROM checkpoints WHERE id='attachments'",
    ),
    before,
  );
  using upstream = new DatabaseSync(store.index);
  upstream.exec(
    'ALTER TABLE messages RENAME COLUMN flags TO unrecognized_flags',
  );
  await assert.rejects(
    run.run(),
    (error) =>
      error instanceof PipelineError &&
      error.cause instanceof Error &&
      error.cause.name === 'MailSchemaError',
  );
  assert.deepEqual(
    parsedProperties(
      rows(join(dir.path, 'out.sqlite'), 'SELECT id, properties FROM accounts'),
    ),
    expectedAccounts(store.root),
  );
  await mkdir(join(dir.path, 'missing-output'));
  const missing = await pipeline(
    new AppleMailSource({
      path: join(dir.path, 'absent'),
      accounts: store.accounts,
    }),
    join(dir.path, 'missing-output'),
  );
  await assert.rejects(
    missing.run(),
    (error) =>
      error instanceof PipelineError &&
      error.cause instanceof Error &&
      error.cause.name === 'MailUnavailableError' &&
      /Full Disk Access/.test(error.cause.message),
  );
});

test('An unreadable Accounts store fails only accounts and smtpServers, naming Full Disk Access', async () => {
  await using dir = await mkdtempDisposable(
    join(tmpdir(), 'elt-mail-accounts-'),
  );
  const store = await fixture(join(dir.path, 'Mail'));
  const source = new AppleMailSource({
    path: store.root,
    accounts: new AccountsStore(join(dir.path, 'missing/Accounts4.sqlite')),
  });

  await assert.rejects((await pipeline(source, dir.path)).run(), (error) => {
    assert.ok(error instanceof PipelineError);
    const failed = error.results.filter(({ failures }) => failures.length > 0);
    assert.deepEqual(
      failed.map(({ copy }) => copy.from.name),
      ['accounts', 'smtpServers'],
    );
    for (const { error: cause } of failed.flatMap(({ failures }) => failures)) {
      assert.ok(cause instanceof AccountsUnavailableError);
      assert.match(cause.message, /Full Disk Access/);
    }
    const loaded = error.results.filter(
      ({ failures }) => failures.length === 0,
    );
    assert.equal(loaded.length, 40);
    assert.ok(loaded.every(({ count }) => count > 0));
    return true;
  });
});

test('An unreadable Accounts store leaves Mail’s watch running', async () => {
  await using dir = await mkdtempDisposable(
    join(tmpdir(), 'elt-mail-accounts-watch-'),
  );
  const store = await fixture(join(dir.path, 'Mail'));
  const source = new AppleMailSource({
    path: store.root,
    accounts: new AccountsStore(join(dir.path, 'missing/Accounts4.sqlite')),
  });
  const abort = new AbortController();
  const watch = source.watch({
    streams: [source.accounts, source.messages],
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
  });
  assert.deepEqual((await watch.next()).value, [
    source.accounts,
    source.messages,
  ]);

  using upstream = new DatabaseSync(store.index);
  upstream.exec('UPDATE messages SET flagged=1 WHERE ROWID=1');

  assert.deepEqual((await watch.next()).value, [
    source.accounts,
    source.messages,
  ]);
  abort.abort();
  assert.equal((await watch.next()).done, true);
});

test('Mail’s watch refreshes only accounts and smtpServers when only the Accounts store commits', async () => {
  await using dir = await mkdtempDisposable(
    join(tmpdir(), 'elt-mail-accounts-watch-'),
  );
  const store = await fixture(join(dir.path, 'Mail'));
  // Outside the Mail directory, as ~/Library/Accounts is, so only the store's
  // own commits reach the watch.
  const accountsPath = join(dir.path, 'Accounts4.sqlite');
  const source = new AppleMailSource({
    path: store.root,
    accounts: scratchAccounts(accountsPath),
  });
  const abort = new AbortController();
  const watch = source.watch({
    streams: [source.accounts, source.smtpServers, source.messages],
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
  });
  assert.deepEqual((await watch.next()).value, [
    source.accounts,
    source.smtpServers,
    source.messages,
  ]);

  // A Mail change can add a mailbox host, so it refreshes the account streams
  // too. It also absorbs the fixture's last writes, which FSEvents can report
  // just after the watch starts.
  using upstream = new DatabaseSync(store.index);
  upstream.exec('UPDATE messages SET flagged=1 WHERE ROWID=1');
  assert.deepEqual((await watch.next()).value, [
    source.accounts,
    source.smtpServers,
    source.messages,
  ]);

  using accounts = new DatabaseSync(accountsPath);
  accounts.exec(
    "UPDATE ZACCOUNT SET ZACCOUNTDESCRIPTION = 'Renamed' WHERE ZIDENTIFIER = 'ICLOUD'",
  );

  assert.deepEqual((await watch.next()).value, [
    source.accounts,
    source.smtpServers,
  ]);
  abort.abort();
  assert.equal((await watch.next()).done, true);
});

test('Mail watches index commits and file-only downloads, cancels, and exports readable Markdown', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-mail-watch-'));
  const store = await fixture(join(dir.path, 'Mail'));
  const source = new AppleMailSource({
    path: store.root,
    accounts: store.accounts,
  });
  const abort = new AbortController();
  const watch = source.watch({
    streams: [source.messages, source.attachments],
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
  });
  assert.deepEqual((await watch.next()).value, [
    source.messages,
    source.attachments,
  ]);
  using upstream = new DatabaseSync(store.index);
  upstream.exec('UPDATE messages SET flagged=1 WHERE ROWID=1');
  assert.deepEqual((await watch.next()).value, [
    source.messages,
    source.attachments,
  ]);
  await writeFile(
    join(store.data, 'Attachments/1/2/detached.pdf'),
    '%PDF-changed',
  );
  assert.deepEqual((await watch.next()).value, [
    source.messages,
    source.attachments,
  ]);
  abort.abort();
  assert.equal((await watch.next()).done, true);
  const destination = new MarkdownDestination({
    path: join(dir.path, 'markdown'),
  });
  const attachments = new LocalFiles({ directory: join(dir.path, 'files') });
  const exportMail = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(source.messageParts, destination.file('parts.md'), {
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite',
          }),
          new Copy(
            source.attachments,
            destination.file('attachments.md', {
              fields: [
                new FileRead(
                  'attachmentRef',
                  source.attachments.file.store(attachments),
                ),
              ],
            }),
          ),
        ],
      }),
    ],
  });
  await exportMail.run();
  const files = await readdir(join(dir.path, 'markdown'), { recursive: true });
  const contents = await Promise.all(
    files
      .filter((name) => name.endsWith('.md'))
      .map((name) => readFile(join(dir.path, 'markdown', name), 'utf8')),
  );
  assert.ok(contents.some((text) => text.includes('Hello 🌍')));
  const stored = (
    await readdir(attachments.directory, {
      recursive: true,
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  assert.ok(stored.length > 0);
  const references = contents
    .flatMap((text) =>
      Array.from(
        text.matchAll(/^<!-- elt-record:([A-Za-z0-9+/=]+) -->$/gm),
        ([, encoded]) =>
          JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8'))
            .attachmentRef,
      ),
    )
    .filter((reference) => typeof reference === 'string');
  assert.deepEqual(new Set(references), new Set(stored));
  await exportMail.run();
  for (const path of stored) await readFile(path);
  await exportMail.clear();
  for (const path of stored)
    await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('Mail tracking pixels keep exact local files and database bytes with null OCR text', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-mail-pixels-'));
  const store = await fixture(join(dir.path, 'Mail'));
  const images = [];
  for (const width of [1, 2, 3]) {
    const chunk = (type: string, data: Buffer) => {
      const label = Buffer.from(type);
      const result = Buffer.alloc(data.length + 12);
      result.writeUInt32BE(data.length);
      label.copy(result, 4);
      data.copy(result, 8);
      result.writeUInt32BE(
        crc32(Buffer.concat([label, data])),
        data.length + 8,
      );
      return result;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(width, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const pixels = Buffer.concat(
      Array.from({ length: width }, () =>
        Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 255)]),
      ),
    );
    images.push(
      Buffer.concat([
        Buffer.from('89504e470d0a1a0a', 'hex'),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(pixels)),
        chunk('IEND', Buffer.alloc(0)),
      ]),
    );
  }
  const raw = [
    'Content-Type: multipart/mixed; boundary="pixels"',
    '',
    ...images.flatMap((bytes, i) => [
      '--pixels',
      'Content-Type: image/png',
      `Content-Disposition: inline; filename="${i}.png"`,
      'Content-Transfer-Encoding: base64',
      '',
      bytes.toString('base64'),
    ]),
    '--pixels--',
    '',
  ].join('\r\n');
  await writeFile(
    join(store.data, 'Messages/1.partial.emlx'),
    `${Buffer.byteLength(raw)}\n${raw}`,
  );
  using upstream = new DatabaseSync(store.index);
  upstream.exec('DELETE FROM attachments');
  const source = new AppleMailSource({
    path: store.root,
    accounts: store.accounts,
  });
  const destination = new SQLiteDestination({
    path: join(dir.path, 'images.sqlite'),
  });
  const files = new LocalFiles({ directory: join(dir.path, 'files') });
  await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(
            source.attachments,
            destination.table('images', (columns) => [
              ...SQLiteColumns.fromSchema(source.attachments.jsonSchema),
              columns
                .text('content')
                .from(source.attachments.file)
                .parse(new MacOSDocumentParser()),
              columns.blob('bytes').from(source.attachments.file),
              columns
                .text('attachmentRef')
                .from(source.attachments.file.store(files)),
            ]),
          ),
        ],
      }),
    ],
  }).run();
  const output = rows(
    destination.path,
    'SELECT content,bytes,attachmentRef FROM images ORDER BY partId',
  );
  assert.equal(output.length, 3);
  for (const [i, row] of output.entries()) {
    assert.equal(row.content, null);
    assert.deepEqual(bytes(destination.path, 'images', row.bytes), images[i]);
    assert.deepEqual(await readFile(String(row.attachmentRef)), images[i]);
  }
});

test('Mail reads as documented views whose MIME, rule and subject joins hold, with raw dates and missing files explicit', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'mail-marts-'));
  const store = await fixture(join(dir.path, 'Mail'));
  const source = new AppleMailSource({
    path: store.root,
    accounts: store.accounts,
  });
  const mail = await appleImport(source, join(dir.path, 'import'));
  await mail.load();

  // Every stream reads through its own documented view.
  const views = new Set(
    mail
      .read(`SELECT name FROM catalog WHERE kind = 'view'`)
      .map(({ name }) => name),
  );
  const { streams } = await source.discover();
  assert.equal(streams.length, 42);
  assert.deepEqual(
    streams.map(({ name }) => snake(name)).filter((view) => !views.has(view)),
    [],
  );
  assert.deepEqual(
    mail
      .read(
        `
        SELECT m.id, s.subject, count(r.id) AS recipients
        FROM messages m
        JOIN subjects s ON s.id = m.subject
        LEFT JOIN recipients r ON r.message = m.id
        GROUP BY m.id, s.subject ORDER BY m.id`,
      )
      .map((found) => ({ ...found })),
    [
      { id: '1', subject: 'Hello 🌍', recipients: 1 },
      { id: '2', subject: 'Hello 🌍', recipients: 0 },
    ],
  );
  assert.deepEqual(
    parsedProperties(mail.read('SELECT id, properties FROM accounts')),
    expectedAccounts(store.root),
  );
  assert.deepEqual(
    parsedProperties(mail.read('SELECT id, properties FROM smtp_servers')),
    expectedSmtpServers,
  );
  // The host of a mailbox URL names the account that owns it.
  assert.deepEqual(
    mail
      .read(
        `
        WITH b AS (SELECT url, substr(url, instr(url, '://') + 3) AS rest FROM mailboxes)
        SELECT b.url, a.properties ->> '$.type' AS type
        FROM b JOIN accounts a ON a.id = substr(b.rest, 1, instr(b.rest, '/') - 1)
        ORDER BY b.url`,
      )
      .map((found) => ({ ...found })),
    [
      { url: 'imap://ACCOUNT/INBOX', type: 'com.apple.account.IMAP' },
      { url: 'local://LOCAL/Archive', type: 'local' },
    ],
  );
  const [parts] = mail.read(`
    SELECT count(*) FILTER (WHERE p."partId" IS NOT NULL) AS parented,
      count(*) FILTER (WHERE p."partId" IS NULL) AS orphaned
    FROM message_parts c
    LEFT JOIN message_parts p ON p."messageId" = c."messageId" AND p."partId" = c."parentPartId"
    WHERE c."parentPartId" IS NOT NULL`);
  assert.ok(Number(parts?.parented) > 0);
  assert.equal(parts?.orphaned, 0);
  assert.deepEqual(
    mail
      .read(
        `SELECT value FROM message_headers WHERE name = 'received' ORDER BY position`,
      )
      .map(({ value }) => value),
    ['first', 'second'],
  );
  const [conditions] = mail.read(`
    SELECT count(*) AS total, count(r.id) AS matched
    FROM rule_conditions c
    LEFT JOIN rules r ON r.scope = c.scope AND r.id = c."ownerId"`);
  assert.ok(Number(conditions?.total) > 0);
  assert.equal(conditions?.matched, conditions?.total);
  assert.deepEqual(
    mail
      .read(`SELECT "startDateRaw" FROM events`)
      .map(({ startDateRaw }) => startDateRaw),
    [123],
  );
  const attachments = mail.read(
    `SELECT "availableLocally", "attachmentRef" FROM attachments ORDER BY "messageId", "partId"`,
  );
  assert.equal(
    await readFile(String(attachments[0]?.attachmentRef), 'utf8'),
    '%PDF-fixture',
  );
  assert.deepEqual(
    attachments
      .filter(({ availableLocally }) => !availableLocally)
      .map(({ attachmentRef }) => attachmentRef),
    [null, null],
  );
  assert.deepEqual(
    mail
      .read(
        `SELECT "messageId", "availableLocally" FROM message_files ORDER BY "messageId"`,
      )
      .map((found) => ({ ...found })),
    [
      { messageId: '1', availableLocally: 1 },
      { messageId: '2', availableLocally: 0 },
    ],
  );
});

test('this Mac’s Mail accounts and SMTP servers read from the Accounts store with every documented property', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Mail requires macOS');
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-mail-live-'));
  const source = new AppleMailSource({
    path: mailDirectory,
    accounts: new AccountsStore(accountsStorePath),
  });
  const destination = new SQLiteDestination({
    path: join(dir.path, 'out.sqlite'),
  });

  try {
    await new Pipeline({
      connections: [
        new Connection({
          name: 'live',
          source,
          destination,
          steps: [source.accounts, source.smtpServers].map(
            (stream) => new Copy(stream, destination.table(stream.name)),
          ),
        }),
      ],
    }).run();
  } catch (error) {
    if (
      error instanceof PipelineError &&
      error.errors.every(
        (cause: unknown) =>
          cause instanceof MailUnavailableError ||
          cause instanceof AccountsUnavailableError,
      )
    )
      return t.skip('no access to Mail or the Accounts store');
    throw error;
  }

  // Checked without printing a value: these are the user's own accounts.
  using index = new DatabaseSync(
    join(await mailVersionDirectory(mailDirectory), 'MailData/Envelope Index'),
    { readOnly: true },
  );
  const hosts = new Set(
    index
      .prepare('SELECT url FROM mailboxes')
      .all()
      .map(({ url }) => new URL(String(url)).hostname),
  );
  const accounts = parsedProperties(
    rows(destination.path, 'SELECT id, properties FROM accounts'),
  );
  assert.equal(accounts.length, hosts.size);
  for (const { id, properties } of accounts) {
    assert.ok(hosts.has(String(id)), 'an account id is not a mailbox host');
    // A host the store does not know keeps its URL scheme as its type; only
    // On My Mac hosts have no account there.
    assert.ok(
      properties.type === 'local' ||
        String(properties.type).startsWith('com.apple.account.'),
      'a mailbox host has no account in the Accounts store',
    );
    assert.deepEqual(Object.keys(properties).sort(), [
      'directory',
      'emailAddresses',
      'enabled',
      'fullName',
      'id',
      'name',
      'parentType',
      'port',
      'sendingServerId',
      'serverName',
      'type',
      'userName',
      'usesSsl',
    ]);
  }
  for (const { properties } of parsedProperties(
    rows(destination.path, 'SELECT id, properties FROM smtpServers'),
  ))
    assert.deepEqual(Object.keys(properties).sort(), [
      'enabled',
      'id',
      'name',
      'port',
      'serverName',
      'userName',
      'usesSsl',
    ]);
});
