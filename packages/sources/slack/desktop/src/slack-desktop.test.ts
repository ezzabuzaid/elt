import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtempDisposable,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import v8 from 'node:v8';

import snappy from 'snappyjs';

import {
  Connection,
  Copy,
  type CopyResult,
  Pipeline,
  PipelineError,
  type Stream,
  type Target,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
} from '@workspace/elt-sqlite';
import {
  SlackDesktopFormatError,
  SlackDesktopStore,
  SlackDesktopUnavailableError,
} from '@workspace/sdk-slack-desktop';

import { SlackDesktopSource } from './slack-desktop-source.ts';

// The Slack app keeps each signed-in workspace's client state in Chromium's
// IndexedDB for app.slack.com: LevelDB files whose values Blink wraps, and
// a blob file holding the Snappy-compressed V8 serialization of the state.
// These writers lay the bytes out as Chromium does, so the store under test
// is the upstream's own format, not a mock of the reader.

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++)
    crc = crc & 1 ? 0x82f63b78 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

// LevelDB's masked CRC-32C.
function maskedCrc(...parts: Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts)
    for (const byte of part)
      crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function fixed32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function fixed64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

const prefixed = (bytes: Uint8Array) =>
  Buffer.concat([varint(bytes.length), bytes]);

type Write = readonly [key: Buffer, value: Buffer | null];

// A log of write batches, one record each, in 32 KiB blocks; a record that
// crosses a block is split into first, middle and last fragments.
function leveldbLog(
  batches: readonly { sequence: number; writes: readonly Write[] }[],
): Buffer {
  const blockSize = 32768;
  const out: Buffer[] = [];
  let offset = 0;
  for (const { sequence, writes } of batches) {
    let payload = Buffer.concat([
      fixed64(BigInt(sequence)),
      fixed32(writes.length),
      ...writes.map(([key, value]) =>
        value === null
          ? Buffer.concat([Buffer.of(0), prefixed(key)])
          : Buffer.concat([Buffer.of(1), prefixed(key), prefixed(value)]),
      ),
    ]);
    let first = true;
    for (;;) {
      const left = blockSize - (offset % blockSize);
      if (left < 7) {
        out.push(Buffer.alloc(left));
        offset += left;
        continue;
      }
      const fragment = payload.subarray(0, left - 7);
      payload = payload.subarray(fragment.length);
      const last = payload.length === 0;
      const type = first && last ? 1 : first ? 2 : last ? 4 : 3;
      const header = Buffer.alloc(7);
      header.writeUInt32LE(maskedCrc(Buffer.of(type), fragment));
      header.writeUInt16LE(fragment.length, 4);
      header.writeUInt8(type, 6);
      out.push(header, fragment);
      offset += 7 + fragment.length;
      first = false;
      if (last) break;
    }
  }
  return Buffer.concat(out);
}

// A table of one Snappy-compressed data block, its index and a footer. Keys
// are internal keys: the user key, then the sequence shifted left 8 and the
// type, 1 for a value.
function leveldbTable(
  entries: readonly { key: Buffer; sequence: number; value: Buffer | null }[],
): Buffer {
  const block = (pairs: readonly (readonly [Buffer, Buffer])[]) =>
    Buffer.concat([
      ...pairs.map(([key, value]) =>
        Buffer.concat([
          varint(0),
          varint(key.length),
          varint(value.length),
          key,
          value,
        ]),
      ),
      fixed32(0),
      fixed32(1),
    ]);
  const parts: Buffer[] = [];
  let offset = 0;
  const append = (contents: Buffer, compress: boolean) => {
    const stored = compress ? Buffer.from(snappy.compress(contents)) : contents;
    const type = Buffer.of(compress ? 1 : 0);
    const handle = Buffer.concat([varint(offset), varint(stored.length)]);
    parts.push(stored, type, fixed32(maskedCrc(stored, type)));
    offset += stored.length + 5;
    return handle;
  };
  // A deletion compaction kept is type 0 with an empty value.
  const internal = entries.map(
    ({ key, sequence, value }) =>
      [
        Buffer.concat([
          key,
          fixed64((BigInt(sequence) << 8n) | (value === null ? 0n : 1n)),
        ]),
        value ?? Buffer.alloc(0),
      ] as const,
  );
  const data = append(block(internal), true);
  const metaindex = append(block([]), false);
  const lastKey = internal.at(-1)?.[0] ?? Buffer.alloc(0);
  const index = append(block([[lastKey, data]]), false);
  const footer = Buffer.alloc(48);
  Buffer.concat([metaindex, index]).copy(footer);
  footer.writeBigUInt64LE(0xdb4775248b80fb57n, 40);
  return Buffer.concat([...parts, footer]);
}

// A MANIFEST of one version edit: Chromium's comparator, the first log to
// replay, and the live tables.
function manifest(logNumber: number, tables: readonly number[]): Buffer {
  const edit = Buffer.concat([
    varint(1),
    prefixed(Buffer.from('idb_cmp1')),
    varint(2),
    varint(logNumber),
    ...tables.flatMap((number) => [
      varint(7),
      varint(0),
      varint(number),
      varint(0),
      prefixed(Buffer.alloc(8)),
      prefixed(Buffer.alloc(8)),
    ]),
  ]);
  const header = Buffer.alloc(7);
  header.writeUInt32LE(maskedCrc(Buffer.of(1), edit));
  header.writeUInt16LE(edit.length, 4);
  header.writeUInt8(1, 6);
  return Buffer.concat([header, edit]);
}

// IndexedDB's key prefix: one byte packing the byte lengths of the database,
// object store and index ids, then each id in as few bytes as it needs.
function keyPrefix(
  database: number,
  objectStore: number,
  index: number,
): Buffer {
  const int = (value: number) => {
    const bytes: number[] = [];
    let rest = value;
    do {
      bytes.push(rest & 0xff);
      rest >>>= 8;
    } while (rest > 0);
    return Buffer.from(bytes);
  };
  const [d, o, i] = [int(database), int(objectStore), int(index)];
  return Buffer.concat([
    Buffer.of(((d.length - 1) << 5) | ((o.length - 1) << 2) | (i.length - 1)),
    d,
    o,
    i,
  ]);
}

const utf16be = (text: string) => Buffer.from(text, 'utf16le').swap16();
const withLength = (text: string) =>
  Buffer.concat([varint(text.length), utf16be(text)]);
const stringKey = (text: string) =>
  Buffer.concat([Buffer.of(1), withLength(text)]);

// Blink's envelope (version 21, no trailer) around V8's serialization in the
// format Slack's V8 writes, 16; Node's V8 writes 15, which differs only in
// buffer sizes, which a client state has none of.
function serialized(state: unknown, version = 16): Buffer {
  const serializer = new v8.Serializer();
  serializer.writeHeader();
  serializer.writeValue(state);
  const bytes = serializer.releaseBuffer();
  bytes[1] = version;
  return Buffer.concat([Buffer.of(0xff, 0x15, 0xfe), Buffer.alloc(12), bytes]);
}

type ValueForm = 'blob' | 'compressed' | 'plain';

type ClientRecord = {
  readonly team: string;
  readonly user: string;
  readonly state: unknown;
  readonly form?: ValueForm;
  readonly version?: number;
};

const indexedDBPath = 'IndexedDB/https_app.slack.com_0.indexeddb.leveldb';
const reduxDatabase = 2;
const reduxStore = 1;

// Writes the Slack app's store under home, as the app leaves it after saving
// these clients: in a log, or compacted into a table with later writes in the
// log. Each save takes the next blob number, as Chromium's does.
class SlackStore {
  readonly directory: string;
  #sequence = 1;
  #blob = 0x100;

  constructor(home: string) {
    this.directory = join(
      home,
      'Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack',
    );
  }

  get #leveldb() {
    return join(this.directory, indexedDBPath);
  }

  async #writes(clients: readonly ClientRecord[]): Promise<Write[]> {
    const writes: Write[] = [
      [
        Buffer.concat([
          keyPrefix(0, 0, 0),
          Buffer.of(201),
          withLength('https_app.slack.com_0@1'),
          withLength('reduxPersistence'),
        ]),
        Buffer.of(reduxDatabase),
      ],
      [
        Buffer.concat([
          keyPrefix(reduxDatabase, 0, 0),
          Buffer.of(50),
          varint(reduxStore),
          Buffer.of(0),
        ]),
        utf16be('reduxPersistenceStore'),
      ],
    ];
    for (const client of clients) {
      const key = stringKey(
        `persist:slack-client-${client.team}-${client.user}`,
      );
      const value = serialized(client.state, client.version);
      const form = client.form ?? 'blob';
      let stored: Buffer;
      if (form === 'plain') stored = value;
      else {
        const compressed = Buffer.concat([
          Buffer.of(0xff, 0x11, 0x02),
          Buffer.from(snappy.compress(value)),
        ]);
        if (form === 'compressed') stored = compressed;
        else {
          const number = this.#blob++;
          const path = join(
            this.directory,
            'IndexedDB/https_app.slack.com_0.indexeddb.blob',
            reduxDatabase.toString(16),
            ((number & 0xff00) >> 8).toString(16).padStart(2, '0'),
            number.toString(16),
          );
          await mkdir(join(path, '..'), { recursive: true });
          await writeFile(path, compressed);
          writes.push([
            Buffer.concat([keyPrefix(reduxDatabase, reduxStore, 3), key]),
            Buffer.concat([
              Buffer.of(0),
              varint(number),
              withLength('application/vnd.blink-idb-value-wrapper'),
              varint(compressed.length),
            ]),
          ]);
          stored = Buffer.concat([
            Buffer.of(0xff, 0x11, 0x01),
            varint(compressed.length),
            varint(0),
          ]);
        }
      }
      writes.push([
        Buffer.concat([keyPrefix(reduxDatabase, reduxStore, 1), key]),
        Buffer.concat([varint(1), stored]),
      ]);
    }
    return writes;
  }

  // The app saving these clients and dropping these records, all in its log.
  async save(
    clients: readonly ClientRecord[],
    dropped: readonly ClientRecord[] = [],
  ): Promise<void> {
    await mkdir(this.#leveldb, { recursive: true });
    const writes: Write[] = [
      ...(await this.#writes(clients)),
      ...dropped.map(({ team, user }): Write => [
        Buffer.concat([
          keyPrefix(reduxDatabase, reduxStore, 1),
          stringKey(`persist:slack-client-${team}-${user}`),
        ]),
        null,
      ]),
    ];
    const sequence = this.#sequence;
    this.#sequence += writes.length;
    await writeFile(join(this.#leveldb, 'CURRENT'), 'MANIFEST-000001\n');
    await writeFile(join(this.#leveldb, 'MANIFEST-000001'), manifest(0, []));
    await writeFile(
      join(this.#leveldb, '000003.log'),
      leveldbLog([{ sequence, writes }]),
    );
  }

  // The app having compacted these clients into a table, with the records
  // tableDropped deletes kept there as newer deletions, then saving later
  // writes, and dropping records, in a new log.
  async compact(
    compacted: readonly ClientRecord[],
    later: readonly ClientRecord[],
    dropped: readonly ClientRecord[] = [],
    tableDropped: readonly ClientRecord[] = [],
  ): Promise<void> {
    await rm(this.#leveldb, { recursive: true, force: true });
    await mkdir(this.#leveldb, { recursive: true });
    const tabled = [
      ...(await this.#writes(compacted)),
      ...tableDropped.map(({ team, user }): Write => [
        Buffer.concat([
          keyPrefix(reduxDatabase, reduxStore, 1),
          stringKey(`persist:slack-client-${team}-${user}`),
        ]),
        null,
      ]),
    ].map(([key, value], index) => ({
      key,
      sequence: this.#sequence + index,
      value,
    }));
    this.#sequence += tabled.length;
    await writeFile(join(this.#leveldb, '000005.ldb'), leveldbTable(tabled));
    const writes: Write[] = [
      ...(await this.#writes(later)),
      ...dropped.map(({ team, user }): Write => [
        Buffer.concat([
          keyPrefix(reduxDatabase, reduxStore, 1),
          stringKey(`persist:slack-client-${team}-${user}`),
        ]),
        null,
      ]),
    ];
    const sequence = this.#sequence;
    this.#sequence += writes.length;
    await writeFile(join(this.#leveldb, 'CURRENT'), 'MANIFEST-000004\n');
    await writeFile(join(this.#leveldb, 'MANIFEST-000004'), manifest(6, [5]));
    await writeFile(
      join(this.#leveldb, '000006.log'),
      leveldbLog([{ sequence, writes }]),
    );
  }
}

type MessageFixture = {
  readonly ts: string;
  readonly user?: string;
  readonly text?: string;
  readonly subtype?: string;
  readonly edited?: { readonly user: string; readonly ts: string };
  readonly reactions?: readonly {
    readonly name: string;
    readonly users: readonly string[];
    readonly count: number;
  }[];
  readonly attachments?: readonly Record<string, unknown>[];
  // The thread it replies in, as a reply's thread_ts.
  readonly reply?: string;
  readonly gone?: true;
  readonly thread?: {
    readonly replies: number;
    readonly users: readonly string[];
    readonly latest: string;
  };
  // The files it shares, by ID, as the client keeps them.
  readonly files?: readonly string[];
};

type FileFixture = {
  readonly id: string;
  readonly name: string;
  readonly mode: 'hosted' | 'snippet' | 'list';
  // Where it was shared: a public channel and the sharing message's ts.
  readonly shared?: readonly (readonly [string, string])[];
};

type ListFixture = {
  readonly id: string;
  readonly records: readonly {
    readonly id: string;
    readonly position: string;
    readonly name: string;
  }[];
};

type ChannelFixture = {
  readonly id: string;
  readonly name: string;
  readonly kind?: 'public' | 'private' | 'im' | 'mpim';
  readonly members?: readonly string[];
  readonly topic?: unknown;
};

type MemberFixture = {
  readonly id: string;
  readonly name: string;
  readonly realName: string;
  readonly gone?: true;
};

const created = 1767963142;

// A client's state as the Slack app persists it: Slack's own slice and field
// names, collections keyed by id, messages by channel and ts, and the history
// ranges the client holds. UI slices the reader ignores sit beside them.
function clientState({
  team,
  user,
  channels,
  members,
  messages = {},
  held = {},
  sections = [],
  files = [],
  lists = [],
}: {
  team: { readonly id: string; readonly name: string; readonly plan?: string };
  user: string;
  channels: readonly ChannelFixture[];
  members: readonly MemberFixture[];
  messages?: Readonly<Record<string, readonly MessageFixture[]>>;
  held?: Readonly<Record<string, readonly (readonly [string, string])[]>>;
  sections?: readonly {
    readonly id: string;
    readonly name: string;
    readonly channels: readonly string[];
  }[];
  files?: readonly FileFixture[];
  lists?: readonly ListFixture[];
}) {
  const reactionKey = (channel: string, ts: string) =>
    `message-${ts}-${channel}`;
  return {
    selfTeamIds: {
      teamId: team.id,
      internalWorkspaceIds: [team.id],
      defaultWorkspaceId: team.id,
    },
    teams: {
      [team.id]: {
        id: team.id,
        name: team.name,
        domain: team.name.toLowerCase(),
        url: `https://${team.name.toLowerCase()}.slack.com/`,
        email_domain: '',
        plan: team.plan ?? '',
        date_created: created,
        icon: {
          image_230: `https://avatars.slack-edge.com/${team.id}_230.png`,
        },
      },
    },
    channels: Object.fromEntries(
      channels.map(
        ({ id, name, kind = 'public', members: channelMembers, topic }) => [
          id,
          {
            id,
            name,
            is_channel: kind === 'public' || kind === 'private',
            is_im: kind === 'im',
            is_mpim: kind === 'mpim',
            is_private: kind !== 'public',
            is_archived: false,
            is_general: id === 'C1',
            is_member: true,
            created,
            creator: user,
            updated: 1781864461637,
            topic: topic ?? { value: '', creator: '', last_set: 0 },
            purpose: {
              value: `About ${name}`,
              creator: user,
              last_set: created,
            },
            previous_names: [],
            ...(kind === 'im' ? { user: channelMembers?.[0] } : {}),
            ...(kind === 'mpim' ? { members: channelMembers } : {}),
            scroll_top: 120,
            unreads: [],
          },
        ],
      ),
    ),
    members: Object.fromEntries(
      members.map(({ id, name, realName, gone }) => [
        id,
        gone
          ? { id, isNonExistent: true }
          : {
              id,
              team_id: team.id,
              name,
              real_name: realName,
              deleted: false,
              tz: 'Europe/London',
              is_bot: false,
              is_self: id === user,
              updated: 1772116148,
              profile: {
                real_name: realName,
                display_name: name,
                email: `${name}@example.com`,
                image_192: `https://avatars.slack-edge.com/${id}_192.png`,
                status_text: '',
                status_emoji: '',
                status_expiration: 0,
              },
            },
      ]),
    ),
    bots: {
      B1: {
        id: 'B1',
        name: 'deploys',
        app_id: 'A1',
        deleted: false,
        updated: created,
      },
    },
    apps: {
      A1: {
        id: 'A1',
        name: 'Deploys',
        desc: 'Ships builds',
        is_installed: true,
      },
    },
    messages: Object.fromEntries(
      Object.entries(messages).map(([channel, list]) => [
        channel,
        Object.fromEntries(
          list.map(
            ({
              ts,
              user: author = user,
              text = '',
              subtype,
              edited,
              attachments,
              files: fileIds,
              reply,
              gone,
              thread,
            }) => [
              ts,
              gone
                ? { channel, ts, id: ts, isNonExistent: true }
                : {
                    type: 'message',
                    ts,
                    channel,
                    user: author,
                    text,
                    client_msg_id: `client-${ts}`,
                    _rxn_key: reactionKey(channel, ts),
                    __meta__: { lastUpdatedTs: ts },
                    blocks: [{ type: 'rich_text', block_id: ts, elements: [] }],
                    ...(subtype ? { subtype } : {}),
                    ...(edited ? { edited } : {}),
                    ...(attachments ? { attachments } : {}),
                    ...(fileIds ? { files: fileIds } : {}),
                    ...(reply ? { _hidden_reply: true, thread_ts: reply } : {}),
                    ...(thread
                      ? {
                          thread_ts: ts,
                          reply_count: thread.replies,
                          reply_users: thread.users,
                          latest_reply: thread.latest,
                        }
                      : {}),
                  },
            ],
          ),
        ),
      ]),
    ),
    reactions: Object.fromEntries(
      Object.entries(messages).flatMap(([channel, list]) =>
        list.flatMap(({ ts, reactions }) =>
          reactions === undefined
            ? []
            : [
                [
                  reactionKey(channel, ts),
                  reactions.map((reaction) => ({
                    ...reaction,
                    baseName: reaction.name,
                  })),
                ],
              ],
        ),
      ),
    ),
    channelHistory: Object.fromEntries(
      Object.entries(held).map(([channel, ranges]) => [
        channel,
        {
          reachedStart: false,
          reachedEnd: true,
          // A conversation the client opened and holds nothing of has one
          // slice with no ends, as the app saved D-conversations on 2026-10-09.
          slices:
            ranges.length === 0
              ? [{ timestamps: [] }]
              : ranges.map(([start, end]) => ({
                  start,
                  end,
                  timestamps: (messages[channel] ?? [])
                    .filter(
                      ({ ts, reply }) => !reply && ts >= start && ts <= end,
                    )
                    .map(({ ts }) => ts),
                })),
        },
      ]),
    ),
    files: Object.fromEntries(
      files.map(({ id, name, mode, shared = [] }) => [
        id,
        {
          id,
          name,
          title: name,
          mode,
          filetype: mode === 'list' ? 'list' : 'markdown',
          mimetype: 'text/markdown',
          pretty_type: mode === 'list' ? 'List' : 'Markdown (raw)',
          size: 37,
          user,
          created: created,
          timestamp: created,
          is_external: false,
          is_public: true,
          is_deleted: false,
          is_tombstoned: false,
          url_private: `https://files.slack.com/files-pri/${team.id}-${id}/${name}`,
          permalink: `https://${team.name.toLowerCase()}.slack.com/files/${user}/${id}/${name}`,
          ...(mode === 'snippet' ? { preview: 'line one', lines: 2 } : {}),
          ...(mode === 'list'
            ? {
                list_metadata: {
                  schema: [{ id: 'Col1', name: 'Task', type: 'text' }],
                },
              }
            : {}),
          shares: {
            public: Object.fromEntries(
              shared.map(([channel, ts]) => [
                channel,
                [{ ts, share_user_id: user, source: 'UNKNOWN' }],
              ]),
            ),
          },
          comments: [],
          localUpdated: 1790000000000,
        },
      ]),
    ),
    lists: {
      listsById: Object.fromEntries(
        lists.map(({ id, records }) => [
          id,
          {
            records: Object.fromEntries(
              records.map(({ id: record, position, name }) => [
                `${id}-${record}`,
                {
                  id: record,
                  fields: { id: record, name, Col1: name },
                  dateCreated: created,
                  createdBy: user,
                  threadTs: '1790000000.000900',
                  position,
                  parentRecordId: '',
                  updatedTimestamp: '1790000100',
                  updatedBy: user,
                  isArchived: false,
                },
              ]),
            ),
            parentRecordsById: {},
          },
        ]),
      ),
      clock: { _milliseconds: 1, _counter: 0, _node: 'node' },
    },
    channelCursors: Object.fromEntries(
      channels.map(({ id }) => [id, '1790000000.000100']),
    ),
    channelLatests: Object.fromEntries(
      channels.map(({ id }) => [id, '0000000000.000000']),
    ),
    channelSections: {
      channelSectionById: {},
      orderedChannelSectionList: sections.map(({ id, name }, index) => ({
        id,
        type: 'standard',
        name,
        emoji: '',
        nextChannelSectionId: sections[index + 1]?.id ?? null,
      })),
      channelIdsByChannelSectionId: Object.fromEntries(
        sections.map(({ id, channels: ids }) => [id, ids]),
      ),
    },
    threadSub: {
      [`C2-1790000000.000200`]: {
        id: 'C2-1790000000.000200',
        subscribed: true,
        lastRead: '1790000000.000300',
      },
    },
    userPrefs: { time24: true, tz: 'Europe/London' },
    teamPrefs: { [team.id]: { display_real_names: false } },
    view: { 'v2::main::home::sidebar': { scroll: 3 } },
    experiments: { agents_in_dm_sidebar: { group: 'on' } },
  };
}

const january = { id: 'T1', name: 'January' };
const self = { id: 'U1', name: 'ezz', realName: 'Ezz Abuzaid' };
const sara = { id: 'U2', name: 'sara', realName: 'Sara Haddad' };
const omar = { id: 'U3', name: 'omar', realName: 'Omar Said' };
const general = { id: 'C1', name: 'general' };
const random = { id: 'C2', name: 'random' };

// A workspace with two channels, a direct message and a group direct message,
// and messages in the channels' held history.
function januaryClient(
  overrides: Partial<Parameters<typeof clientState>[0]> = {},
): ClientRecord {
  return {
    team: january.id,
    user: self.id,
    state: clientState({
      team: january,
      user: self.id,
      channels: [
        general,
        random,
        { id: 'D1', name: 'U2', kind: 'im', members: ['U2'] },
        {
          id: 'G1',
          name: 'mpdm-ezz--sara--omar-1',
          kind: 'mpim',
          members: ['U1', 'U2', 'U3'],
        },
      ],
      members: [self, sara, omar],
      messages: {
        C1: [
          { ts: '1790000000.000100', text: 'welcome' },
          { ts: '1790000000.000200', user: 'U2', text: 'hi' },
          { ts: '1790000000.000300', text: 'agenda' },
        ],
      },
      held: { C1: [['1790000000.000100', '1790000000.000300']] },
      ...overrides,
    }),
  };
}

function rows(path: string, sql: string) {
  using db = new DatabaseSync(path, { readOnly: true });
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

async function pipeline(source: SlackDesktopSource, directory: string) {
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
          (stream: Stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: stream.name,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  });
}

const counts = (results: readonly CopyResult<Target>[]) =>
  Object.fromEntries(
    results.map(({ copy, count, deleted }) => [
      copy.from.name,
      { count, deleted },
    ]),
  );

const nothing = { count: 0, deleted: 0 };
const unchanged = Object.fromEntries(
  [
    'workspaces',
    'channels',
    'channelMembers',
    'members',
    'bots',
    'apps',
    'messages',
    'threadReplies',
    'messageAttachments',
    'messageReactions',
    'messageFiles',
    'files',
    'fileShares',
    'listRecords',
    'channelSections',
    'channelSectionChannels',
    'threadSubscriptions',
    'preferences',
  ].map((name) => [name, nothing]),
);

async function scratch() {
  const dir = await mkdtempDisposable(join(tmpdir(), 'slack-desktop-'));
  return {
    dir,
    store: new SlackStore(dir.path),
    out: join(dir.path, 'out.sqlite'),
  };
}

test('every stream loads what the Slack app keeps, ts exact and sent times to the microsecond', async () => {
  const { dir, store, out } = await scratch();
  await using _ = dir;
  await store.save([
    januaryClient({
      members: [
        self,
        sara,
        omar,
        { id: 'U9', name: '', realName: '', gone: true },
      ],
      messages: {
        C1: [
          {
            ts: '1790000000.000100',
            text: 'see <https://example.com|the plan>',
            edited: { user: 'U1', ts: '1790000005.000000' },
            reactions: [{ name: 'thumbsup', users: ['U2', 'U3'], count: 2 }],
            attachments: [
              {
                id: '1',
                fallback: 'the plan',
                from_url: 'https://example.com',
                is_msg_unfurl: false,
              },
            ],
            thread: { replies: 2, users: ['U2'], latest: '1790000009.000001' },
            files: ['F1'],
          },
          {
            ts: '1790000000.000200',
            user: 'U2',
            text: 'hi',
            subtype: 'thread_broadcast',
          },
          {
            ts: '1790000001.000001',
            text: 'a reply',
            reply: '1790000000.000100',
          },
          { ts: '1790000000.000250', gone: true },
        ],
      },
      sections: [{ id: 'S1', name: 'Projects', channels: ['C2', 'C1'] }],
      files: [
        {
          id: 'F1',
          name: 'notes.md',
          mode: 'snippet',
          shared: [['C1', '1790000000.000100']],
        },
        { id: 'L1', name: 'Launch', mode: 'list' },
      ],
      lists: [
        {
          id: 'L1',
          records: [{ id: 'Rec1', position: '1790000050', name: 'Ship it' }],
        },
      ],
    }),
  ]);
  const run = await pipeline(new SlackDesktopSource(store.directory), dir.path);

  const results = counts(await run.run());

  assert.deepEqual(results, {
    workspaces: { count: 1, deleted: 0 },
    channels: { count: 4, deleted: 0 },
    channelMembers: { count: 3, deleted: 0 },
    members: { count: 3, deleted: 0 },
    bots: { count: 1, deleted: 0 },
    apps: { count: 1, deleted: 0 },
    messages: { count: 2, deleted: 0 },
    threadReplies: { count: 1, deleted: 0 },
    messageAttachments: { count: 1, deleted: 0 },
    messageReactions: { count: 1, deleted: 0 },
    messageFiles: { count: 1, deleted: 0 },
    files: { count: 2, deleted: 0 },
    fileShares: { count: 1, deleted: 0 },
    listRecords: { count: 1, deleted: 0 },
    channelSections: { count: 1, deleted: 0 },
    channelSectionChannels: { count: 2, deleted: 0 },
    threadSubscriptions: { count: 1, deleted: 0 },
    preferences: { count: 3, deleted: 0 },
  });
  assert.deepEqual(
    rows(
      out,
      'SELECT id, name, domain, url, emailDomain, plan, createdAt, iconUrl, userId FROM workspaces',
    ),
    [
      {
        id: 'T1',
        name: 'January',
        domain: 'january',
        url: 'https://january.slack.com/',
        emailDomain: null,
        plan: null,
        createdAt: '2026-01-09T12:52:22.000Z',
        iconUrl: 'https://avatars.slack-edge.com/T1_230.png',
        userId: 'U1',
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT id, kind, imUserId, name, purpose, purposeSetAt, lastReadTs, latestTs FROM channels ORDER BY id',
    ),
    [
      {
        id: 'C1',
        kind: 'public',
        imUserId: null,
        name: 'general',
        purpose: 'About general',
        purposeSetAt: '2026-01-09T12:52:22.000Z',
        lastReadTs: '1790000000.000100',
        latestTs: null,
      },
      {
        id: 'C2',
        kind: 'public',
        imUserId: null,
        name: 'random',
        purpose: 'About random',
        purposeSetAt: '2026-01-09T12:52:22.000Z',
        lastReadTs: '1790000000.000100',
        latestTs: null,
      },
      {
        id: 'D1',
        kind: 'im',
        imUserId: 'U2',
        name: 'U2',
        purpose: 'About U2',
        purposeSetAt: '2026-01-09T12:52:22.000Z',
        lastReadTs: '1790000000.000100',
        latestTs: null,
      },
      {
        id: 'G1',
        kind: 'mpim',
        imUserId: null,
        name: 'mpdm-ezz--sara--omar-1',
        purpose: 'About mpdm-ezz--sara--omar-1',
        purposeSetAt: '2026-01-09T12:52:22.000Z',
        lastReadTs: '1790000000.000100',
        latestTs: null,
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT channelId, memberId FROM channelMembers ORDER BY memberId',
    ),
    [
      { channelId: 'G1', memberId: 'U1' },
      { channelId: 'G1', memberId: 'U2' },
      { channelId: 'G1', memberId: 'U3' },
    ],
  );
  assert.deepEqual(
    rows(out, 'SELECT id, realName, email, isSelf FROM members ORDER BY id'),
    [
      {
        id: 'U1',
        realName: 'Ezz Abuzaid',
        email: 'ezz@example.com',
        isSelf: 1,
      },
      {
        id: 'U2',
        realName: 'Sara Haddad',
        email: 'sara@example.com',
        isSelf: 0,
      },
      { id: 'U3', realName: 'Omar Said', email: 'omar@example.com', isSelf: 0 },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT ts, sentAt, userId, text, subtype, threadTs, replyCount, replyUserIds, latestReplyTs, editedBy, editedTs, blocks FROM messages ORDER BY ts',
    ),
    [
      {
        ts: '1790000000.000100',
        sentAt: '2026-09-21T14:13:20.000100Z',
        userId: 'U1',
        text: 'see <https://example.com|the plan>',
        subtype: null,
        threadTs: '1790000000.000100',
        replyCount: 2,
        replyUserIds: '["U2"]',
        latestReplyTs: '1790000009.000001',
        editedBy: 'U1',
        editedTs: '1790000005.000000',
        blocks:
          '[{"type":"rich_text","block_id":"1790000000.000100","elements":[]}]',
      },
      {
        ts: '1790000000.000200',
        sentAt: '2026-09-21T14:13:20.000200Z',
        userId: 'U2',
        text: 'hi',
        subtype: 'thread_broadcast',
        threadTs: null,
        replyCount: null,
        replyUserIds: '[]',
        latestReplyTs: null,
        editedBy: null,
        editedTs: null,
        blocks:
          '[{"type":"rich_text","block_id":"1790000000.000200","elements":[]}]',
      },
    ],
  );
  assert.deepEqual(
    rows(out, 'SELECT channelId, ts, threadTs, text FROM threadReplies'),
    [
      {
        channelId: 'C1',
        ts: '1790000001.000001',
        threadTs: '1790000000.000100',
        text: 'a reply',
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT messageTs, position, attachmentId, fallback, fromUrl, isMessageUnfurl FROM messageAttachments',
    ),
    [
      {
        messageTs: '1790000000.000100',
        position: 0,
        attachmentId: '1',
        fallback: 'the plan',
        fromUrl: 'https://example.com',
        isMessageUnfurl: 0,
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT messageTs, name, baseName, count, userIds FROM messageReactions',
    ),
    [
      {
        messageTs: '1790000000.000100',
        name: 'thumbsup',
        baseName: 'thumbsup',
        count: 2,
        userIds: '["U2","U3"]',
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT id, name, mode, filetype, size, userId, createdAt, preview, lines, urlPrivate, listMetadata FROM files ORDER BY id',
    ),
    [
      {
        id: 'F1',
        name: 'notes.md',
        mode: 'snippet',
        filetype: 'markdown',
        size: 37,
        userId: 'U1',
        createdAt: '2026-01-09T12:52:22.000Z',
        preview: 'line one',
        lines: 2,
        urlPrivate: 'https://files.slack.com/files-pri/T1-F1/notes.md',
        listMetadata: null,
      },
      {
        id: 'L1',
        name: 'Launch',
        mode: 'list',
        filetype: 'list',
        size: 37,
        userId: 'U1',
        createdAt: '2026-01-09T12:52:22.000Z',
        preview: null,
        lines: null,
        urlPrivate: 'https://files.slack.com/files-pri/T1-L1/Launch',
        listMetadata: '{"schema":[{"id":"Col1","name":"Task","type":"text"}]}',
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT fileId, channelId, ts, isPrivate, sharedBy FROM fileShares',
    ),
    [
      {
        fileId: 'F1',
        channelId: 'C1',
        ts: '1790000000.000100',
        isPrivate: 0,
        sharedBy: 'U1',
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT channelId, messageTs, position, fileId FROM messageFiles',
    ),
    [
      {
        channelId: 'C1',
        messageTs: '1790000000.000100',
        position: 0,
        fileId: 'F1',
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT listId, id, position, createdAt, updatedAt, isArchived, fields FROM listRecords',
    ),
    [
      {
        listId: 'L1',
        id: 'Rec1',
        position: '1790000050',
        createdAt: '2026-01-09T12:52:22.000Z',
        updatedAt: '2026-09-21T14:15:00.000Z',
        isArchived: 0,
        fields: '{"id":"Rec1","name":"Ship it","Col1":"Ship it"}',
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT sectionId, channelId, position FROM channelSectionChannels ORDER BY position',
    ),
    [
      { sectionId: 'S1', channelId: 'C2', position: 0 },
      { sectionId: 'S1', channelId: 'C1', position: 1 },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT channelId, threadTs, isSubscribed, lastReadTs FROM threadSubscriptions',
    ),
    [
      {
        channelId: 'C2',
        threadTs: '1790000000.000200',
        isSubscribed: 1,
        lastReadTs: '1790000000.000300',
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT scope, name, value FROM preferences ORDER BY scope, name',
    ),
    [
      { scope: 'team', name: 'display_real_names', value: 'false' },
      { scope: 'user', name: 'time24', value: 'true' },
      { scope: 'user', name: 'tz', value: '"Europe/London"' },
    ],
  );
});

test('a message deleted inside history the app holds is deleted; one the app dropped from its cache stays', async () => {
  const { dir, store, out } = await scratch();
  await using _ = dir;
  const message = (ts: string) => ({ ts, text: `at ${ts}` });
  // .000100 (to be dropped) and .000500 (to be deleted) share F9.
  const sharing = (ts: string) => ({ ...message(ts), files: ['F9'] });
  // Two held ranges of C1 with a gap between them, and C2 and D1 held whole.
  await store.save([
    januaryClient({
      messages: {
        C1: [
          sharing('1790000000.000100'),
          ...[
            '1790000000.000200',
            '1790000000.000300',
            '1790000000.000400',
          ].map(message),
          sharing('1790000000.000500'),
          message('1790000000.000600'),
        ],
        C2: [message('1790000000.000700'), message('1790000000.000800')],
        D1: [message('1790000001.000100')],
        // A reply whose ts falls inside a held range of its channel.
        C3: [{ ts: '1790000000.000150', reply: '1790000000.000100' }],
      },
      files: [
        {
          id: 'F9',
          name: 'old.md',
          mode: 'hosted',
          shared: [['C2', '1790000000.000700']],
        },
      ],
      lists: [
        { id: 'L9', records: [{ id: 'Rec9', position: '1', name: 'Old row' }] },
      ],
      held: {
        C1: [
          ['1790000000.000100', '1790000000.000300'],
          ['1790000000.000500', '1790000000.000600'],
        ],
        C2: [['1790000000.000700', '1790000000.000800']],
        D1: [['1790000001.000100', '1790000001.000100']],
        C3: [['1790000000.000100', '1790000000.000200']],
      },
    }),
  ]);
  const run = await pipeline(new SlackDesktopSource(store.directory), dir.path);
  await run.run();

  // The app now holds C1 from .000200 to .000300 and from .000500 on: .000100
  // fell out of the held history (dropped), .000300 vanished at the edge of a
  // range it still holds and .000500 inside one (deleted), and .000400, in
  // the gap, and .000600 are the client's notes that the message no longer
  // exists (deleted). Of C2 the client holds an empty slice, which covers
  // none of its messages, so they stay, as does D1's message, whose
  // conversation has no history entry at all.
  await store.save([
    januaryClient({
      messages: {
        C1: [
          message('1790000000.000200'),
          { ts: '1790000000.000400', gone: true },
          { ts: '1790000000.000600', gone: true },
          message('1790000000.000900'),
        ],
      },
      held: {
        C1: [
          ['1790000000.000200', '1790000000.000300'],
          ['1790000000.000500', '1790000000.000900'],
        ],
        C2: [],
        C3: [['1790000000.000100', '1790000000.000200']],
      },
    }),
  ]);
  const second = counts(await run.run());

  assert.deepEqual(second.messages, { count: 1, deleted: 4 });
  // The app dropped F9 from its cache: the file and where it was shared stay.
  assert.deepEqual(
    [second.files, second.fileShares],
    [
      { count: 0, deleted: 0 },
      { count: 0, deleted: 0 },
    ],
  );
  assert.deepEqual(rows(out, 'SELECT id FROM files'), [{ id: 'F9' }]);
  // A message's files follow it: the dropped message keeps its share, the
  // deleted one loses it. A List row the app dropped stays.
  assert.deepEqual(second.messageFiles, { count: 0, deleted: 1 });
  assert.deepEqual(rows(out, 'SELECT messageTs, fileId FROM messageFiles'), [
    { messageTs: '1790000000.000100', fileId: 'F9' },
  ]);
  assert.deepEqual(second.listRecords, { count: 0, deleted: 0 });
  assert.deepEqual(rows(out, 'SELECT listId, id FROM listRecords'), [
    { listId: 'L9', id: 'Rec9' },
  ]);
  // A thread reply carries no range, so one the app drops stays.
  assert.deepEqual(second.threadReplies, { count: 0, deleted: 0 });
  assert.deepEqual(rows(out, 'SELECT channelId, ts FROM threadReplies'), [
    { channelId: 'C3', ts: '1790000000.000150' },
  ]);
  assert.deepEqual(
    rows(out, 'SELECT channelId, ts FROM messages ORDER BY channelId, ts'),
    [
      { channelId: 'C1', ts: '1790000000.000100' },
      { channelId: 'C1', ts: '1790000000.000200' },
      { channelId: 'C1', ts: '1790000000.000900' },
      { channelId: 'C2', ts: '1790000000.000700' },
      { channelId: 'C2', ts: '1790000000.000800' },
      { channelId: 'D1', ts: '1790000001.000100' },
    ],
  );
});

test('reactions follow their message: one removed from a held message is deleted, those of a dropped message stay', async () => {
  const { dir, store, out } = await scratch();
  await using _ = dir;
  const thumbs = { name: 'thumbsup', users: ['U2'], count: 1 };
  const eyes = { name: 'eyes', users: ['U3'], count: 1 };
  await store.save([
    januaryClient({
      messages: {
        C1: [
          { ts: '1790000000.000100', reactions: [thumbs, eyes] },
          { ts: '1790000000.000200', reactions: [thumbs] },
        ],
      },
      held: { C1: [['1790000000.000100', '1790000000.000200']] },
    }),
  ]);
  const run = await pipeline(new SlackDesktopSource(store.directory), dir.path);
  await run.run();

  await store.save([
    januaryClient({
      messages: {
        C1: [
          {
            ts: '1790000000.000200',
            reactions: [{ ...thumbs, users: ['U2', 'U1'], count: 2 }],
          },
        ],
      },
      held: { C1: [['1790000000.000200', '1790000000.000200']] },
    }),
  ]);
  const second = counts(await run.run());

  assert.deepEqual(second.messageReactions, { count: 1, deleted: 0 });
  assert.deepEqual(
    rows(
      out,
      'SELECT messageTs, name, count, userIds FROM messageReactions ORDER BY messageTs, name',
    ),
    [
      {
        messageTs: '1790000000.000100',
        name: 'eyes',
        count: 1,
        userIds: '["U3"]',
      },
      {
        messageTs: '1790000000.000100',
        name: 'thumbsup',
        count: 1,
        userIds: '["U2"]',
      },
      {
        messageTs: '1790000000.000200',
        name: 'thumbsup',
        count: 2,
        userIds: '["U2","U1"]',
      },
    ],
  );

  await store.save([
    januaryClient({
      messages: { C1: [{ ts: '1790000000.000200' }] },
      held: { C1: [['1790000000.000200', '1790000000.000200']] },
    }),
  ]);
  assert.deepEqual(counts(await run.run()).messageReactions, {
    count: 0,
    deleted: 1,
  });
});

test('an edited message updates its row in place', async () => {
  const { dir, store, out } = await scratch();
  await using _ = dir;
  await store.save([januaryClient()]);
  const run = await pipeline(new SlackDesktopSource(store.directory), dir.path);
  await run.run();

  await store.save([
    januaryClient({
      messages: {
        C1: [
          { ts: '1790000000.000100', text: 'welcome' },
          {
            ts: '1790000000.000200',
            user: 'U2',
            text: 'hi all',
            edited: { user: 'U2', ts: '1790000100.000000' },
          },
          { ts: '1790000000.000300', text: 'agenda' },
        ],
      },
    }),
  ]);
  const second = counts(await run.run());

  assert.deepEqual(second.messages, { count: 1, deleted: 0 });
  assert.deepEqual(
    rows(
      out,
      "SELECT text, editedBy, editedTs FROM messages WHERE ts = '1790000000.000200'",
    ),
    [{ text: 'hi all', editedBy: 'U2', editedTs: '1790000100.000000' }],
  );
});

test('a workspace the app no longer keeps keeps its rows while another syncs, and a new workspace loads', async () => {
  const { dir, store, out } = await scratch();
  await using _ = dir;
  const delivery = (messages: readonly MessageFixture[]): ClientRecord => ({
    team: 'T2',
    user: 'U7',
    state: clientState({
      team: { id: 'T2', name: 'Delivery', plan: 'plus' },
      user: 'U7',
      channels: [general],
      members: [{ id: 'U7', name: 'ezz', realName: 'Ezz Abuzaid' }],
      messages: { C1: messages },
      held: { C1: [['1790000000.000100', '1790000000.000900']] },
    }),
  });
  await store.save([januaryClient()]);
  const run = await pipeline(new SlackDesktopSource(store.directory), dir.path);
  await run.run();

  await store.save([januaryClient(), delivery([{ ts: '1790000000.000400' }])]);
  const joined = counts(await run.run());
  await store.save(
    [delivery([{ ts: '1790000000.000400' }, { ts: '1790000000.000500' }])],
    [januaryClient()],
  );
  const left = counts(await run.run());

  assert.deepEqual(
    [joined.workspaces, joined.messages],
    [
      { count: 1, deleted: 0 },
      { count: 1, deleted: 0 },
    ],
  );
  assert.deepEqual(
    Object.values(left).reduce((sum, { deleted }) => sum + deleted, 0),
    0,
  );
  assert.deepEqual(left.messages, { count: 1, deleted: 0 });
  assert.deepEqual(
    rows(
      out,
      'SELECT workspaceId, count(*) AS messages FROM messages GROUP BY workspaceId',
    ),
    [
      { workspaceId: 'T1', messages: 3 },
      { workspaceId: 'T2', messages: 2 },
    ],
  );
  assert.deepEqual(rows(out, 'SELECT id, plan FROM workspaces ORDER BY id'), [
    { id: 'T1', plan: null },
    { id: 'T2', plan: 'plus' },
  ]);
});

test('a conversation the app stops listing is deleted and a renamed member updates', async () => {
  const { dir, store, out } = await scratch();
  await using _ = dir;
  await store.save([januaryClient()]);
  const run = await pipeline(new SlackDesktopSource(store.directory), dir.path);
  await run.run();

  await store.save([
    januaryClient({
      channels: [general, random],
      members: [self, { ...sara, realName: 'Sara Haddad-Khoury' }, omar],
    }),
  ]);
  const second = counts(await run.run());

  assert.deepEqual(
    [second.channels, second.channelMembers, second.members],
    [
      { count: 0, deleted: 2 },
      { count: 0, deleted: 3 },
      { count: 1, deleted: 0 },
    ],
  );
  assert.deepEqual(rows(out, 'SELECT id FROM channels ORDER BY id'), [
    { id: 'C1' },
    { id: 'C2' },
  ]);
  assert.deepEqual(rows(out, "SELECT realName FROM members WHERE id = 'U2'"), [
    { realName: 'Sara Haddad-Khoury' },
  ]);
});

test('a second run over a store the app saved again unchanged, under a new blob, writes nothing', async () => {
  const { dir, store } = await scratch();
  await using _ = dir;
  await store.save([januaryClient()]);
  const run = await pipeline(new SlackDesktopSource(store.directory), dir.path);
  await run.run();

  await store.save([januaryClient()]);

  assert.deepEqual(counts(await run.run()), unchanged);
});

test('a store compacted into a table reads as the app left it: later saves win and a dropped record does not come back', async () => {
  const { dir, store, out } = await scratch();
  await using _ = dir;
  const delivery = (channelName: string): ClientRecord => ({
    team: 'T2',
    user: 'U7',
    state: clientState({
      team: { id: 'T2', name: 'Delivery' },
      user: 'U7',
      channels: [{ ...general, name: channelName }],
      members: [{ id: 'U7', name: 'ezz', realName: 'Ezz Abuzaid' }],
    }),
  });
  const third = (channelName: string): ClientRecord => ({
    team: 'T3',
    user: 'U8',
    state: clientState({
      team: { id: 'T3', name: 'Third' },
      user: 'U8',
      channels: [{ ...general, name: channelName }],
      members: [{ id: 'U8', name: 'ezz', realName: 'Ezz Abuzaid' }],
    }),
  });
  await store.compact(
    [januaryClient(), delivery('general'), third('general')],
    [],
  );
  const run = await pipeline(new SlackDesktopSource(store.directory), dir.path);
  const first = counts(await run.run());

  // The table holds every record, Delivery's and Third's with their channel
  // renamed, and a newer deletion of Third's; the log saves January again
  // with a channel renamed and then drops Delivery's. Neither rename the
  // table holds may load.
  await store.compact(
    [januaryClient(), delivery('general-renamed'), third('general-renamed')],
    [
      januaryClient({
        channels: [general, { ...random, name: 'random-talk' }],
      }),
    ],
    [delivery('general-renamed')],
    [third('general-renamed')],
  );
  const second = counts(await run.run());

  assert.deepEqual(first.workspaces, { count: 3, deleted: 0 });
  assert.deepEqual(second.channels, { count: 1, deleted: 2 });
  assert.deepEqual(
    rows(
      out,
      'SELECT workspaceId, id, name FROM channels ORDER BY workspaceId, id',
    ),
    [
      { workspaceId: 'T1', id: 'C1', name: 'general' },
      { workspaceId: 'T1', id: 'C2', name: 'random-talk' },
      { workspaceId: 'T2', id: 'C1', name: 'general' },
      { workspaceId: 'T3', id: 'C1', name: 'general' },
    ],
  );
});

test('a state kept compressed in LevelDB or plain decodes as one moved to a blob file', async () => {
  const forms: ValueForm[] = ['blob', 'compressed', 'plain'];
  const loaded = [];
  for (const form of forms) {
    const { dir, store, out } = await scratch();
    await using _ = dir;
    await store.save([{ ...januaryClient(), form }]);
    await (
      await pipeline(new SlackDesktopSource(store.directory), dir.path)
    ).run();
    loaded.push(
      rows(out, 'SELECT channelId, ts, text FROM messages ORDER BY ts'),
    );
  }

  assert.equal(loaded[0]?.length, 3);
  assert.deepEqual(loaded[1], loaded[0]);
  assert.deepEqual(loaded[2], loaded[0]);
});

test('text keeps accents, Arabic and emoji exactly, and a value the state shares loads wherever it is used', async () => {
  const { dir, store, out } = await scratch();
  await using _ = dir;
  // V8 writes a Latin-1 string one byte a character, and any other as UTF-16.
  const topic = { value: 'Café ☕ مرحبا 👋', creator: 'U1', last_set: created };
  await store.save([
    januaryClient({
      channels: [
        { ...general, topic },
        { ...random, topic },
      ],
      messages: {
        C1: [
          { ts: '1790000000.000100', text: 'naïve résumé' },
          { ts: '1790000000.000200', text: 'شكرا 🙏🏽' },
        ],
      },
    }),
  ]);
  await (
    await pipeline(new SlackDesktopSource(store.directory), dir.path)
  ).run();

  assert.deepEqual(rows(out, 'SELECT id, topic FROM channels ORDER BY id'), [
    { id: 'C1', topic: 'Café ☕ مرحبا 👋' },
    { id: 'C2', topic: 'Café ☕ مرحبا 👋' },
  ]);
  assert.deepEqual(rows(out, 'SELECT text FROM messages ORDER BY ts'), [
    { text: 'naïve résumé' },
    { text: 'شكرا 🙏🏽' },
  ]);
});

test('a store that stops being readable fails every stream, naming Full Disk Access, and keeps what loaded', async () => {
  const { dir, store, out } = await scratch();
  await using _ = dir;
  await store.save([januaryClient()]);
  const run = await pipeline(new SlackDesktopSource(store.directory), dir.path);
  await run.run();
  const indexedDB = join(store.directory, 'IndexedDB');
  const { streams } = await new SlackDesktopSource(store.directory).discover();
  // chmod stands in for macOS withholding the app's container from a process
  // without Full Disk Access: both fail the read with EACCES or EPERM.
  await chmod(indexedDB, 0o000);

  try {
    await assert.rejects(run.run(), (error) => {
      assert.ok(error instanceof PipelineError);
      assert.equal(error.errors.length, streams.length);
      for (const cause of error.errors) {
        assert.ok(cause instanceof SlackDesktopUnavailableError);
        assert.match(cause.message, /Full Disk Access/);
      }
      return true;
    });
  } finally {
    await chmod(indexedDB, 0o755);
  }

  assert.deepEqual(rows(out, 'SELECT count(*) AS n FROM messages'), [{ n: 3 }]);
  assert.deepEqual(counts(await run.run()), unchanged);
});

test('a store in a format this reader does not know fails every stream by name and keeps what loaded', async () => {
  const { dir, store, out } = await scratch();
  await using _ = dir;
  await store.save([januaryClient()]);
  const run = await pipeline(new SlackDesktopSource(store.directory), dir.path);
  await run.run();
  const { streams } = await new SlackDesktopSource(store.directory).discover();
  const damaged = async (writes: () => Promise<void>, problem: RegExp) => {
    await writes();
    await assert.rejects(run.run(), (error) => {
      assert.ok(error instanceof PipelineError);
      assert.equal(error.errors.length, streams.length);
      for (const cause of error.errors) {
        assert.ok(cause instanceof SlackDesktopFormatError);
        assert.match(cause.message, problem);
      }
      return true;
    });
  };

  // A newer V8 than this reader knows, a log record whose checksum fails, and
  // a state with a slice in a shape this reader has not verified.
  await damaged(
    () => store.save([{ ...januaryClient(), version: 17 }]),
    /format version 17/,
  );
  await damaged(async () => {
    const log = join(store.directory, indexedDBPath, '000003.log');
    const bytes = await readFile(log);
    bytes.writeUInt8(
      bytes.readUInt8(bytes.length - 1) ^ 0xff,
      bytes.length - 1,
    );
    await writeFile(log, bytes);
  }, /fails its checksum/);
  await damaged(
    () =>
      store.save([
        {
          ...januaryClient(),
          state: {
            ...clientState({
              team: january,
              user: 'U1',
              channels: [],
              members: [],
            }),
            channels: { C1: { id: 'C1', name: 7 } },
          },
        },
      ]),
    /state\.channels\.C1\.name is not a string/,
  );
  const reshaped = (slice: string, value: unknown) =>
    store.save([
      {
        ...januaryClient(),
        state: {
          ...clientState({
            team: january,
            user: 'U1',
            channels: [],
            members: [],
          }),
          [slice]: value,
        },
      },
    ]);
  await damaged(
    () =>
      reshaped('reactions', {
        'message-1790000000.000100-C1': [{ name: 'eyes', users: ['U2'] }],
      }),
    /count is not a number/,
  );
  await damaged(
    () =>
      reshaped('channelHistory', {
        C1: { slices: [{ start: '1790000000.000100', timestamps: [] }] },
      }),
    /a slice of C1's history has only one end/,
  );
  await damaged(
    () =>
      reshaped('lists', {
        listsById: {
          L1: {
            records: { 'L1-Rec1': { id: 'Rec1', updatedTimestamp: 'soon' } },
          },
        },
      }),
    /soon is not a count of seconds/,
  );

  assert.deepEqual(rows(out, 'SELECT count(*) AS n FROM messages'), [{ n: 3 }]);
  assert.deepEqual(rows(out, 'SELECT count(*) AS n FROM channels'), [{ n: 4 }]);
});

test('a store that fails to read for another reason fails every stream as that error, not as missing access, and keeps what loaded', async () => {
  const { dir, store, out } = await scratch();
  await using _ = dir;
  await store.save([januaryClient()]);
  const run = await pipeline(new SlackDesktopSource(store.directory), dir.path);
  await run.run();
  // A directory where the log should be: readable, but not a file.
  const log = join(store.directory, indexedDBPath, '000003.log');
  await rm(log);
  await mkdir(log);

  await assert.rejects(run.run(), (error) => {
    assert.ok(error instanceof PipelineError);
    for (const cause of error.errors) {
      assert.ok(!(cause instanceof SlackDesktopUnavailableError));
      assert.equal(Reflect.get(Object(cause), 'code'), 'EISDIR');
    }
    return true;
  });

  assert.deepEqual(rows(out, 'SELECT count(*) AS n FROM messages'), [{ n: 3 }]);
});

test('an import scope keeps the selected workspaces, channels and dates', async () => {
  const { dir, store, out } = await scratch();
  await using _ = dir;
  const other: ClientRecord = {
    team: 'T2',
    user: 'U7',
    state: clientState({
      team: { id: 'T2', name: 'Delivery' },
      user: 'U7',
      channels: [general],
      members: [],
    }),
  };
  await store.save([
    januaryClient({
      messages: {
        C1: [
          { ts: '1789900000.000100' },
          { ts: '1790000000.000100' },
          { ts: '1790100000.000100' },
        ],
        C2: [{ ts: '1790000000.000200' }],
      },
      held: {
        C1: [['1789900000.000100', '1790100000.000100']],
        C2: [['1790000000.000200', '1790000000.000200']],
      },
      sections: [{ id: 'S1', name: 'Projects', channels: ['C2', 'C1'] }],
    }),
    other,
  ]);
  const source = new SlackDesktopSource(store.directory, {
    accountIds: ['T1'],
    collectionIds: ['C1'],
    startAt: '2026-09-21T00:00:00.000Z',
    endAt: '2026-09-22T00:00:00.000Z',
  });

  await (await pipeline(source, dir.path)).run();

  assert.deepEqual(rows(out, 'SELECT id FROM workspaces'), [{ id: 'T1' }]);
  assert.deepEqual(rows(out, 'SELECT id FROM channels'), [{ id: 'C1' }]);
  assert.deepEqual(rows(out, 'SELECT channelId, ts FROM messages'), [
    { channelId: 'C1', ts: '1790000000.000100' },
  ]);
  assert.deepEqual(rows(out, 'SELECT count(*) AS n FROM members'), [{ n: 3 }]);
  // A narrowed import keeps a conversation's place in its sidebar section.
  assert.deepEqual(
    rows(
      out,
      'SELECT sectionId, channelId, position FROM channelSectionChannels',
    ),
    [{ sectionId: 'S1', channelId: 'C1', position: 1 }],
  );
});

test('a Slack watch wakes every stream once, again when the app saves, and stops when aborted', async () => {
  const { dir, store } = await scratch();
  await using _ = dir;
  await store.save([januaryClient()]);
  const run = await pipeline(new SlackDesktopSource(store.directory), dir.path);
  const controller = new AbortController();
  const batches: Record<string, { count: number; deleted: number }>[] = [];

  for await (const { outcomes } of run.watch({
    // A batch that never comes ends the watch, so the assertion fails.
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  })) {
    batches.push(counts(outcomes));
    if (batches.length === 1)
      await store.save([
        januaryClient({
          messages: {
            C1: [
              { ts: '1790000000.000100', text: 'welcome' },
              { ts: '1790000000.000400', text: 'new' },
            ],
          },
          held: { C1: [['1790000000.000100', '1790000000.000400']] },
        }),
      ]);
    // Past the next one-second poll, so a spurious batch would show.
    else setTimeout(() => controller.abort(), 1500);
  }

  assert.equal(batches.length, 2);
  assert.deepEqual(batches[1]?.messages, { count: 1, deleted: 2 });
});

test('this Mac’s Slack app loads every workspace it keeps, and a second read with no save writes nothing', async (t) => {
  if (process.platform !== 'darwin')
    return t.skip('the Slack app’s store is on macOS');
  await using dir = await mkdtempDisposable(
    join(tmpdir(), 'slack-desktop-live-'),
  );
  const out = join(dir.path, 'out.sqlite');
  const run = await pipeline(new SlackDesktopSource(), dir.path);

  try {
    await run.run();
  } catch (error) {
    if (
      error instanceof PipelineError &&
      error.errors.every(
        (cause) => cause instanceof SlackDesktopUnavailableError,
      )
    )
      return t.skip(
        'the Slack app is not installed, or this process lacks Full Disk Access',
      );
    throw error;
  }

  // Counted, never printed.
  const [workspaces, channels, members] = [
    'workspaces',
    'channels',
    'members',
  ].map((table) => rows(out, `SELECT count(*) AS n FROM ${table}`)[0]?.n);
  if (workspaces === 0) return t.skip('the Slack app has saved no workspace');
  assert.ok(Number(channels) > 0);
  assert.ok(Number(members) > 0);
  assert.deepEqual(
    rows(
      out,
      "SELECT count(*) AS n FROM messages WHERE sentAt NOT LIKE '____-__-__T__:__:__.______Z'",
    ),
    [{ n: 0 }],
  );
  // A read that finds unchanged state writes nothing, so no field the app
  // keeps changes between two reads without a save. The app saves every few
  // minutes; a save between the reads may carry real changes.
  const store = new SlackDesktopStore();
  const before = store.version();
  const second = counts(await run.run());
  if (store.version() !== before)
    return t.skip('the Slack app saved between the two reads');
  assert.deepEqual(second, unchanged);
});
