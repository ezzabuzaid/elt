import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  IndexedDBFormatError,
  readIndexedDB
} from "../../chunks/chunk-MWIEVOQM.mjs";
import {
  byId,
  name
} from "../../chunks/chunk-FGFSL4M6.mjs";
import {
  selected,
  withinDates
} from "../../chunks/chunk-YM7ADF2O.mjs";
import {
  AppleConnector
} from "../../chunks/chunk-4RXDIBY4.mjs";
import {
  Catalog,
  Source,
  Stream,
  diffSnapshot,
  validateRecords
} from "../../chunks/chunk-NZNT7H7R.mjs";
import "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/sources/slack/desktop/dist/slack-desktop-source.js
import { setInterval } from "node:timers/promises";

// packages/sdks/slack/desktop/dist/errors.js
var SlackDesktopUnavailableError = class extends Error {
  name = "SlackDesktopUnavailableError";
  constructor(path, cause) {
    super(`The Slack app's store at ${path} cannot be read. Open Slack, sign in and let it save its workspaces. If macOS denies access, allow the process that runs the export Full Disk Access in System Settings > Privacy & Security.`, { cause });
  }
};
var SlackDesktopFormatError = class extends Error {
  name = "SlackDesktopFormatError";
  constructor(record, problem, cause) {
    super(`The Slack app's ${record} has a shape this reader does not read: ${problem}.`, { cause });
  }
};

// packages/sdks/slack/desktop/dist/slack-desktop-store.js
import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// packages/sdks/slack/desktop/dist/fields.js
var Fields = class _Fields {
  #value;
  #record;
  #path;
  constructor(value, record, path) {
    if (!isObject(value))
      throw new SlackDesktopFormatError(record, `${path} is not an object`);
    this.#value = value;
    this.#record = record;
    this.#path = path;
  }
  #fail(name2, expected) {
    throw new SlackDesktopFormatError(this.#record, `${this.#path}.${name2} is not ${expected}`);
  }
  has(name2) {
    return this.#value[name2] !== void 0 && this.#value[name2] !== null;
  }
  // An absent field and an empty string both mean Slack holds no value.
  string(name2) {
    const value = this.#value[name2];
    if (value === void 0 || value === null || value === "")
      return null;
    return typeof value === "string" ? value : this.#fail(name2, "a string");
  }
  requiredString(name2) {
    return this.string(name2) ?? this.#fail(name2, "a non-empty string");
  }
  requiredNumber(name2) {
    return this.number(name2) ?? this.#fail(name2, "a number");
  }
  number(name2) {
    const value = this.#value[name2];
    if (value === void 0 || value === null)
      return null;
    return typeof value === "number" ? value : this.#fail(name2, "a number");
  }
  boolean(name2) {
    const value = this.#value[name2];
    if (value === void 0 || value === null)
      return null;
    return typeof value === "boolean" ? value : this.#fail(name2, "a boolean");
  }
  strings(name2) {
    const value = this.#value[name2];
    if (value === void 0 || value === null)
      return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
      return this.#fail(name2, "a list of strings");
    return value;
  }
  object(name2) {
    return this.has(name2) ? new _Fields(this.#value[name2], this.#record, `${this.#path}.${name2}`) : null;
  }
  // An object's own entries, each read as Fields: Slack's state keys most
  // collections by id.
  entries(name2) {
    const value = this.#value[name2];
    if (value === void 0 || value === null)
      return [];
    if (!isObject(value))
      return this.#fail(name2, "an object");
    return Object.entries(value).map(([key, item]) => [
      key,
      new _Fields(item, this.#record, `${this.#path}.${name2}.${key}`)
    ]);
  }
  // An object's own entries as Slack holds them, such as preferences by name.
  values(name2) {
    const value = this.#value[name2];
    if (value === void 0 || value === null)
      return [];
    return isObject(value) ? Object.entries(value) : this.#fail(name2, "an object");
  }
  // An object whose every value is a string, such as each channel's last read
  // ts by channel id.
  stringValues(name2) {
    return new Map(this.values(name2).map(([key, value]) => [
      key,
      typeof value === "string" ? value : this.#fail(`${name2}.${key}`, "a string")
    ]));
  }
  list(name2) {
    const value = this.#value[name2];
    if (value === void 0 || value === null)
      return [];
    if (!Array.isArray(value))
      return this.#fail(name2, "a list");
    return value.map((item, index) => new _Fields(item, this.#record, `${this.#path}.${name2}[${index}]`));
  }
  // A value kept as the JSON Slack holds, for structures this reader passes
  // through whole, such as a message's rich-text blocks.
  json(name2) {
    return this.has(name2) ? JSON.stringify(this.#value[name2]) : null;
  }
};
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// packages/sdks/slack/desktop/dist/instants.js
function seconds(value) {
  return value === null || value === 0 ? null : new Date(value * 1e3).toISOString();
}
function milliseconds(value) {
  return value === null || value === 0 ? null : new Date(value).toISOString();
}

// packages/sdks/slack/desktop/dist/slack-client-record.js
function readSlackClient(state, record) {
  const root = new Fields(state, record, "state");
  const workspaceId = root.object("selfTeamIds")?.requiredString("teamId") ?? fail(record, "state.selfTeamIds is missing");
  const userId = /-([A-Z0-9]+)$/.exec(record)?.[1];
  if (userId === void 0)
    fail(record, "the record names no user");
  const workspace = root.object("teams")?.object(workspaceId);
  if (workspace === null || workspace === void 0)
    fail(record, `state.teams holds no ${workspaceId}`);
  const cursors = root.stringValues("channelCursors");
  const latests = root.stringValues("channelLatests");
  const reactionLists = root.object("reactions");
  const reactions = new Map(root.values("reactions").map(([key]) => [key, reactionLists?.list(key).map(reaction) ?? []]));
  const held = history(root, record);
  const pinLists = root.object("pins");
  const pinsLoaded = new Set((pinLists?.values("loadingStateByChannel") ?? []).filter(([, state2]) => state2 === "loaded").map(([channelId]) => channelId));
  const existing = (fields) => fields.boolean("isNonExistent") !== true;
  const messagesByChannel = root.object("messages");
  const channelMessages = root.values("messages").flatMap(([channelId]) => (messagesByChannel?.entries(channelId) ?? []).map(([, fields]) => ({
    channelId,
    fields
  })));
  const gone = new Set(channelMessages.filter(({ fields }) => !existing(fields)).map(({ channelId, fields }) => `${channelId} ${fields.requiredString("ts")}`));
  return {
    workspace: {
      id: workspaceId,
      name: workspace.requiredString("name"),
      domain: workspace.requiredString("domain"),
      url: workspace.string("url"),
      emailDomain: workspace.string("email_domain"),
      plan: workspace.string("plan"),
      createdAt: seconds(workspace.number("date_created")),
      iconUrl: workspace.object("icon")?.string("image_230") ?? null
    },
    userId,
    channels: root.entries("channels").filter(([, fields]) => existing(fields)).map(([id21, fields]) => channel(id21, fields, cursors.get(id21) ?? null, latests.get(id21) ?? null)),
    members: root.entries("members").filter(([, fields]) => existing(fields)).map(([id21, fields]) => member(id21, fields)),
    bots: root.entries("bots").map(([id21, fields]) => bot(id21, fields)),
    apps: root.entries("apps").map(([id21, fields]) => app(id21, fields)),
    messages: channelMessages.filter(({ fields }) => existing(fields) && fields.boolean("_hidden_reply") !== true).map(({ channelId, fields }) => message(channelId, fields, record, reactions)),
    threadReplies: channelMessages.filter(({ fields }) => existing(fields) && fields.boolean("_hidden_reply") === true).map(({ channelId, fields }) => message(channelId, fields, record, reactions)),
    files: root.entries("files").filter(([, fields]) => existing(fields)).map(([id21, fields]) => file(id21, fields)),
    listRecords: listRecords(root, existing, record),
    pins: pins(root, pinLists),
    channelSections: sections(root),
    threadSubscriptions: root.entries("threadSub").map(([key, fields]) => threadSubscription(key, fields, record)),
    userGroupMemberships: root.entries("userGroupMembership").map(([userGroupId, fields]) => ({
      userGroupId,
      isMember: fields.boolean("isMember")
    })),
    preferences: preferences(root, workspaceId),
    holds: (channelId, ts9) => gone.has(`${channelId} ${ts9}`) || (held.get(channelId) ?? []).some(({ start, end }) => compareTs(ts9, start) >= 0 && compareTs(ts9, end) <= 0),
    holdsPins: (channelId) => pinsLoaded.has(channelId)
  };
}
function fail(record, problem) {
  throw new SlackDesktopFormatError(record, problem);
}
function instant(ts9, record) {
  const match = /^(\d+)\.(\d{6})$/.exec(ts9);
  if (match?.[1] === void 0 || match[2] === void 0)
    fail(record, `message ts ${ts9} is not seconds.microseconds`);
  return `${new Date(Number(match[1]) * 1e3).toISOString().slice(0, 19)}.${match[2]}Z`;
}
function compareTs(a, b) {
  const left = a.padStart(17, "0");
  const right = b.padStart(17, "0");
  if (left < right)
    return -1;
  if (left > right)
    return 1;
  return 0;
}
function ts(value) {
  return value === null || /^0+(\.0+)?$/.test(value) ? null : value;
}
function note(fields) {
  return {
    value: fields?.string("value") ?? null,
    setBy: fields?.string("creator") ?? null,
    setAt: seconds(fields?.number("last_set") ?? null)
  };
}
function kind(fields) {
  if (fields.boolean("is_im"))
    return "im";
  if (fields.boolean("is_mpim"))
    return "mpim";
  if (fields.boolean("is_private") || fields.boolean("is_group"))
    return "private";
  return "public";
}
function channel(id21, fields, lastReadTs, latestTs) {
  return {
    id: id21,
    name: fields.string("name"),
    kind: kind(fields),
    imUserId: fields.string("user"),
    createdAt: seconds(fields.number("created")),
    creatorId: fields.string("creator"),
    updatedAt: milliseconds(fields.number("updated")),
    isArchived: fields.boolean("is_archived"),
    isGeneral: fields.boolean("is_general"),
    isMember: fields.boolean("is_member"),
    isExternallyShared: fields.boolean("is_ext_shared"),
    isOrgShared: fields.boolean("is_org_shared"),
    topic: note(fields.object("topic")),
    purpose: note(fields.object("purpose")),
    previousNames: fields.strings("previous_names"),
    memberIds: fields.strings("members"),
    lastReadTs: ts(lastReadTs),
    latestTs: ts(latestTs)
  };
}
function member(id21, fields) {
  const profile = fields.object("profile");
  return {
    id: id21,
    teamId: fields.string("team_id"),
    name: fields.string("name"),
    realName: fields.string("real_name") ?? profile?.string("real_name") ?? null,
    displayName: profile?.string("display_name") ?? null,
    firstName: profile?.string("first_name") ?? null,
    lastName: profile?.string("last_name") ?? null,
    title: profile?.string("title") ?? null,
    email: profile?.string("email") ?? null,
    phone: profile?.string("phone") ?? null,
    pronouns: profile?.string("pronouns") ?? null,
    timeZone: fields.string("tz"),
    statusText: profile?.string("status_text") ?? null,
    statusEmoji: profile?.string("status_emoji") ?? null,
    statusExpiresAt: seconds(profile?.number("status_expiration") ?? null),
    avatarUrl: profile?.string("image_192") ?? null,
    botId: profile?.string("bot_id") ?? null,
    appId: profile?.string("api_app_id") ?? null,
    isBot: fields.boolean("is_bot"),
    isAppUser: fields.boolean("is_app_user"),
    isDeleted: fields.boolean("deleted"),
    isAdmin: fields.boolean("is_admin"),
    isOwner: fields.boolean("is_owner"),
    isPrimaryOwner: fields.boolean("is_primary_owner"),
    isRestricted: fields.boolean("is_restricted"),
    isUltraRestricted: fields.boolean("is_ultra_restricted"),
    isInvited: fields.boolean("is_invited_user"),
    isSelf: fields.boolean("is_self"),
    updatedAt: seconds(fields.number("updated"))
  };
}
function bot(id21, fields) {
  return {
    id: id21,
    name: fields.string("name"),
    appId: fields.string("app_id"),
    isDeleted: fields.boolean("deleted"),
    updatedAt: seconds(fields.number("updated"))
  };
}
function app(id21, fields) {
  return {
    id: id21,
    name: fields.string("name"),
    description: fields.string("desc"),
    developerName: fields.string("developer_name"),
    appType: fields.string("app_type"),
    url: fields.string("url"),
    isInstalled: fields.boolean("is_installed"),
    isDistributed: fields.boolean("is_distributed"),
    isWorkflowApp: fields.boolean("is_workflow_app")
  };
}
function reaction(fields) {
  return {
    name: fields.requiredString("name"),
    baseName: fields.string("baseName"),
    count: fields.requiredNumber("count"),
    userIds: fields.strings("users")
  };
}
function attachment(fields) {
  return {
    id: fields.string("id"),
    fallback: fields.string("fallback"),
    pretext: fields.string("pretext"),
    text: fields.string("text"),
    fromUrl: fields.string("from_url"),
    authorId: fields.string("author_id"),
    authorName: fields.string("author_name"),
    authorLink: fields.string("author_link"),
    channelId: fields.string("channel_id"),
    messageTs: fields.string("ts"),
    footer: fields.string("footer"),
    color: fields.string("color"),
    appId: fields.string("app_id"),
    botId: fields.string("bot_id"),
    isMessageUnfurl: fields.boolean("is_msg_unfurl"),
    isAppUnfurl: fields.boolean("is_app_unfurl"),
    fieldsJson: fields.json("fields"),
    blocksJson: fields.json("blocks")
  };
}
function message(channelId, fields, record, reactions) {
  const ts9 = fields.requiredString("ts");
  const edited = fields.object("edited");
  const saved = fields.object("saved");
  const reactionKey = fields.string("_rxn_key");
  return {
    channelId,
    ts: ts9,
    sentAt: instant(ts9, record),
    type: fields.requiredString("type"),
    subtype: fields.string("subtype"),
    userId: fields.string("user"),
    botId: fields.string("bot_id"),
    text: fields.string("text"),
    threadTs: fields.string("thread_ts"),
    replyCount: fields.number("reply_count"),
    replyUserIds: fields.strings("reply_users"),
    latestReplyTs: fields.string("latest_reply"),
    editedBy: edited?.string("user") ?? null,
    editedTs: edited?.string("ts") ?? null,
    clientMessageId: fields.string("client_msg_id"),
    isLocked: fields.boolean("is_locked"),
    isBeyondPlanLimit: fields.boolean("is_beyond_free_limit"),
    savedState: saved?.string("state") ?? null,
    savedTodoState: saved?.string("todo_state") ?? null,
    isSavedArchived: saved?.boolean("is_archived") ?? null,
    blocksJson: fields.json("blocks"),
    attachments: fields.list("attachments").map(attachment),
    reactions: reactionKey === null ? [] : reactions.get(reactionKey) ?? [],
    fileIds: fields.strings("files")
  };
}
function file(id21, fields) {
  const shares = fields.object("shares");
  return {
    id: id21,
    name: fields.string("name"),
    title: fields.string("title"),
    mimetype: fields.string("mimetype"),
    filetype: fields.string("filetype"),
    prettyType: fields.string("pretty_type"),
    mode: fields.string("mode"),
    size: fields.number("size"),
    userId: fields.string("user"),
    createdAt: seconds(fields.number("created")),
    updatedAt: seconds(fields.number("updated")),
    editedAt: seconds(fields.number("edit_timestamp")),
    isExternal: fields.boolean("is_external"),
    externalType: fields.string("external_type"),
    isPublic: fields.boolean("is_public"),
    isDeleted: fields.boolean("is_deleted"),
    isTombstoned: fields.boolean("is_tombstoned"),
    urlPrivate: fields.string("url_private"),
    permalink: fields.string("permalink"),
    preview: fields.string("preview"),
    content: fields.string("content"),
    lines: fields.number("lines"),
    durationMs: fields.number("duration_ms"),
    width: fields.number("original_w"),
    height: fields.number("original_h"),
    listMetadataJson: fields.json("list_metadata"),
    transcriptionJson: fields.json("transcription"),
    shares: ["private", "public"].flatMap((visibility) => (shares?.values(visibility) ?? []).flatMap(([channelId]) => (shares?.object(visibility)?.list(channelId) ?? []).map((share) => ({
      channelId,
      ts: share.requiredString("ts"),
      isPrivate: visibility === "private",
      sharedBy: share.string("share_user_id")
    }))))
  };
}
function listRecords(root, existing, record) {
  return (root.object("lists")?.entries("listsById") ?? []).flatMap(([listId, list]) => list.entries("records").filter(([, fields]) => existing(fields)).map(([, fields]) => ({
    listId,
    id: fields.requiredString("id"),
    position: fields.string("position"),
    parentRecordId: fields.string("parentRecordId"),
    threadTs: fields.string("threadTs"),
    createdAt: seconds(fields.number("dateCreated")),
    createdBy: fields.string("createdBy"),
    updatedAt: secondsText(fields.string("updatedTimestamp"), record),
    updatedBy: fields.string("updatedBy"),
    isArchived: fields.boolean("isArchived"),
    fieldsJson: fields.json("fields")
  })));
}
function secondsText(value, record) {
  if (value === null)
    return null;
  if (!/^\d+$/.test(value))
    fail(record, `${value} is not a count of seconds`);
  return seconds(Number(value));
}
function pins(root, pinLists) {
  const byChannel = pinLists?.object("pinsByChannel");
  const channels = root.object("channels");
  const messages = root.object("messages");
  return (pinLists?.values("pinsByChannel") ?? []).flatMap(([channelId]) => {
    const items = channels?.object(channelId)?.list("pinned_items") ?? [];
    return (byChannel?.list(channelId) ?? []).map((pin) => {
      const ts9 = pin.requiredString("ts");
      const item = items.find((candidate) => candidate.object("message")?.string("ts") === ts9);
      const info = messages?.object(channelId)?.object(ts9)?.object("pinned_info");
      return {
        channelId,
        ts: ts9,
        type: pin.requiredString("type"),
        pinnedBy: item?.string("created_by") ?? info?.string("pinned_by") ?? null,
        pinnedAt: seconds(item?.number("created") ?? info?.number("pinned_ts") ?? null)
      };
    });
  });
}
function history(root, record) {
  return new Map(root.entries("channelHistory").map(([channelId, fields]) => [
    channelId,
    fields.list("slices").flatMap((slice) => {
      const start = slice.string("start");
      const end = slice.string("end");
      if (start === null && end === null)
        return [];
      if (start === null || end === null)
        fail(record, `a slice of ${channelId}'s history has only one end`);
      return [{ start, end }];
    })
  ]));
}
function sections(root) {
  const state = root.object("channelSections");
  if (state === null)
    return [];
  const channelIds = state.object("channelIdsByChannelSectionId");
  return state.list("orderedChannelSectionList").map((section, position) => {
    const id21 = section.requiredString("id");
    return {
      id: id21,
      type: section.requiredString("type"),
      name: section.string("name"),
      emoji: section.string("emoji"),
      position,
      channelIds: channelIds?.strings(id21) ?? []
    };
  });
}
function threadSubscription(key, fields, record) {
  const match = /^([A-Z0-9]+)-(\d+\.\d+)$/.exec(key);
  if (match?.[1] === void 0 || match[2] === void 0)
    fail(record, `thread subscription ${key} names no channel and ts`);
  return {
    channelId: match[1],
    threadTs: match[2],
    isSubscribed: fields.boolean("subscribed"),
    lastReadTs: fields.string("lastRead")
  };
}
function preferences(root, workspaceId) {
  const team = root.object("teamPrefs");
  return [
    ...root.values("userPrefs").map(([name2, value]) => ({
      scope: "user",
      name: name2,
      valueJson: JSON.stringify(value)
    })),
    ...(team?.values(workspaceId) ?? []).map(([name2, value]) => ({
      scope: "team",
      name: name2,
      valueJson: JSON.stringify(value)
    }))
  ];
}

// packages/sdks/slack/desktop/dist/slack-downloads.js
function readSlackDownloads(state, record) {
  const root = new Fields(state, record, "state");
  const byWorkspace = root.object("downloads");
  return root.values("downloads").flatMap(([workspaceId]) => (byWorkspace?.entries(workspaceId) ?? []).map(([fileId, download]) => ({
    workspaceId,
    fileId,
    url: download.string("url"),
    userId: download.string("userId"),
    appVersion: download.string("appVersion"),
    state: download.string("downloadState"),
    progress: download.number("progress"),
    startedAt: milliseconds(download.number("startTime")),
    endedAt: milliseconds(download.number("endTime")),
    path: download.string("downloadPath")
  })));
}

// packages/sdks/slack/desktop/dist/slack-desktop-store.js
var indexedDB = "IndexedDB/https_app.slack.com_0.indexeddb.leveldb";
var reduxDatabase = "reduxPersistence";
var reduxStore = "reduxPersistenceStore";
var clientRecord = /^persist:slack-client-[A-Z0-9]+-[A-Z0-9]+$/;
var rootState = "storage/root-state.json";
var attempts = 3;
var unreadable = /* @__PURE__ */ new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"]);
function slackDesktopDirectory() {
  const direct = join(homedir(), "Library/Application Support/Slack");
  const appStore = join(homedir(), "Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack");
  let selected2;
  let unavailable;
  let newest = -Infinity;
  for (const directory of [direct, appStore]) {
    try {
      const path = join(directory, indexedDB);
      const files = readdirSync(path);
      if (!files.includes("CURRENT"))
        continue;
      const modified = Math.max(...files.map((name2) => statSync(join(path, name2), { throwIfNoEntry: false })?.mtimeMs ?? 0));
      if (modified > newest) {
        selected2 = directory;
        newest = modified;
      }
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR")
        continue;
      unavailable ??= directory;
    }
  }
  return selected2 ?? unavailable ?? direct;
}
var SlackDesktopStore = class {
  #directory;
  constructor(directory = slackDesktopDirectory()) {
    this.#directory = directory;
  }
  // Every signed-in workspace's client as the app last saved it. A workspace
  // appears once its client has saved, which it does every few minutes while
  // it is open and when the app quits.
  async clients() {
    const databases = await this.#read();
    return databases.filter(({ name: name2 }) => name2 === reduxDatabase).flatMap(({ objectStores }) => objectStores).filter(({ name: name2 }) => name2 === reduxStore).flatMap(({ records }) => records).flatMap(({ key, value }) => typeof key === "string" && clientRecord.test(key) ? [readSlackClient(value, key)] : []);
  }
  // The files the app downloaded, in every workspace: none until it has
  // saved its own state.
  async downloads() {
    const text = await this.#rootState();
    if (text === null)
      return [];
    let state;
    try {
      state = JSON.parse(text);
    } catch (error) {
      throw new SlackDesktopFormatError(rootState, "it is not JSON", error);
    }
    return readSlackDownloads(state, rootState);
  }
  // A value that changes whenever the app saves its state, a client's or its
  // own.
  version() {
    const directory = join(this.#directory, indexedDB);
    try {
      return [
        ...readdirSync(directory).sort().map((name2) => join(directory, name2)),
        join(this.#directory, rootState)
      ].map((path) => {
        const stats = statSync(path, { throwIfNoEntry: false });
        return `${path}:${stats?.size}:${stats?.mtimeMs}`;
      }).join("\n");
    } catch (error) {
      throw new SlackDesktopUnavailableError(this.#directory, error);
    }
  }
  async #rootState() {
    try {
      return await readFile(join(this.#directory, rootState), "utf8");
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT")
        return null;
      if (typeof code === "string" && unreadable.has(code))
        throw new SlackDesktopUnavailableError(this.#directory, error);
      throw error;
    }
  }
  async #read() {
    for (let attempt = 1; ; attempt++) {
      try {
        return await readIndexedDB(join(this.#directory, indexedDB));
      } catch (error) {
        if (error instanceof IndexedDBFormatError)
          throw new SlackDesktopFormatError("IndexedDB", error.message, error);
        const code = errorCode(error);
        if (code === "ENOENT" && attempt < attempts && this.#exists())
          continue;
        if (typeof code === "string" && unreadable.has(code))
          throw new SlackDesktopUnavailableError(this.#directory, error);
        throw error;
      }
    }
  }
  #exists() {
    try {
      return statSync(join(this.#directory, indexedDB)).isDirectory();
    } catch {
      return false;
    }
  }
};
function errorCode(error) {
  return error instanceof Error && "code" in error ? error.code : void 0;
}

// packages/sources/slack/desktop/dist/slack-desktop-scan.js
var toMilliseconds = (instant3) => `${instant3.slice(0, 23)}Z`;
var SlackDesktopScan = class {
  #clients;
  #downloads;
  #scope;
  #kept;
  constructor(clients, downloads, scope) {
    this.#clients = clients;
    this.#downloads = downloads;
    this.#scope = scope;
    this.#kept = new Map(clients.status === "fulfilled" ? clients.value.map((client) => [client.workspace.id, client]) : []);
  }
  get clients() {
    return settled(this.#clients).filter(({ workspace }) => selected(this.#scope.accountIds, workspace.id));
  }
  get downloads() {
    return settled(this.#downloads).filter(({ workspaceId }) => selected(this.#scope.accountIds, workspaceId));
  }
  // Whether the app still keeps this workspace: one it no longer keeps, such
  // as one signed out of, says nothing about its rows, so they stay.
  keeps(workspaceId) {
    return typeof workspaceId === "string" && this.#kept.has(workspaceId);
  }
  // Whether the app holds this part of a channel's history, so a message it
  // no longer lists there was deleted rather than dropped from its cache.
  holds(workspaceId, channelId, ts9) {
    if (typeof workspaceId !== "string" || typeof channelId !== "string")
      return false;
    return typeof ts9 === "string" && (this.#kept.get(workspaceId)?.holds(channelId, ts9) ?? false);
  }
  // Whether the app loaded this conversation's whole pin list, so a pin it no
  // longer lists there was removed.
  holdsPins(workspaceId, channelId) {
    if (typeof workspaceId !== "string" || typeof channelId !== "string")
      return false;
    return this.#kept.get(workspaceId)?.holdsPins(channelId) ?? false;
  }
  channelSelected(channelId) {
    return selected(this.#scope.collectionIds, channelId);
  }
  messages(client) {
    return client.messages.filter((message2) => this.#inScope(message2));
  }
  threadReplies(client) {
    return client.threadReplies.filter((message2) => this.#inScope(message2));
  }
  #inScope({ channelId, sentAt }) {
    return this.channelSelected(channelId) && withinDates(this.#scope, toMilliseconds(sentAt));
  }
  // Everything was read when the scan opened; nothing stays open.
  async [Symbol.asyncDispose]() {
  }
};
function settled(read) {
  if (read.status === "rejected")
    throw read.reason;
  return read.value;
}

// packages/sources/slack/desktop/dist/slack-desktop-stream.js
var slackFields = {
  id: { type: "string", minLength: 1 },
  ordinal: { type: "integer", minimum: 0 },
  nullableText: { type: ["string", "null"] },
  nullableBoolean: { type: ["boolean", "null"] },
  nullableInteger: { type: ["integer", "null"] },
  nullableNumber: { type: ["number", "null"] },
  nullableTimestamp: { type: ["string", "null"], format: "date-time" },
  textList: { type: "array", items: { type: "string" } },
  // Slack's ts, seconds and microseconds, kept as the text Slack writes.
  ts: { type: "string", minLength: 1 },
  nullableTs: { type: ["string", "null"] },
  // A ts as an instant, to the microsecond.
  instant: { type: "string", format: "date-time", precision: 6 }
};
var SlackDesktopStream = class {
  supportedSyncModes = Object.freeze([
    "full_refresh",
    "incremental"
  ]);
  // Every read is the whole store, so incremental copies diff snapshots.
  sourceDefinedCursor = true;
  // Whether a record the app no longer holds, where the read covers it, was
  // deleted; a stream whose upstream only forgets says undefined.
  emitsDeletes = true;
  #stream;
  describe() {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }
  read(scan) {
    return validateRecords(this, this.rows(scan).flatMap((row) => this.records(row)), "Slack");
  }
  // Whether the scan vouches for a row it no longer holds, so that it was
  // deleted: every row of a workspace the app still keeps.
  covers(scan, key) {
    return scan.keeps(key.workspaceId);
  }
  // The file a record carries, for streams that support file reads.
  file(_record) {
    return null;
  }
};

// packages/sources/slack/desktop/dist/streams/apps-stream.js
var { id, nullableText, nullableBoolean } = slackFields;
var properties = {
  workspaceId: { ...id, description: "The workspace (workspaces.id)." },
  id: { ...id, description: "Slack\u2019s app ID, such as A0123ABCD." },
  name: { ...nullableText, description: "The app\u2019s name." },
  description: { ...nullableText, description: "What the app says it does." },
  developerName: { ...nullableText, description: "Who made it." },
  appType: { ...nullableText, description: "Slack\u2019s kind of app." },
  url: { ...nullableText, description: "The app\u2019s page." },
  isInstalled: {
    ...nullableBoolean,
    description: "Whether it is installed in the workspace."
  },
  isDistributed: {
    ...nullableBoolean,
    description: "Whether it is distributed to other workspaces."
  },
  isWorkflowApp: {
    ...nullableBoolean,
    description: "Whether it is a Workflow Builder app."
  }
};
var AppsStream = class extends SlackDesktopStream {
  name = "apps";
  primaryKey = ["workspaceId", "id"];
  jsonSchema = {
    type: "object",
    description: "One record per Slack app the app has loaded in a workspace. Primary key workspaceId, id. One the app stops listing is deleted.",
    properties,
    required: Object.keys(properties)
  };
  rows(scan) {
    return scan.clients.flatMap(({ workspace, apps }) => apps.map((app2) => ({ workspaceId: workspace.id, app: app2 })));
  }
  records({ workspaceId, app: app2 }) {
    return [{ workspaceId, ...app2 }];
  }
};

// packages/sources/slack/desktop/dist/streams/bots-stream.js
var { id: id2, nullableText: nullableText2, nullableBoolean: nullableBoolean2, nullableTimestamp } = slackFields;
var properties2 = {
  workspaceId: { ...id2, description: "The workspace (workspaces.id)." },
  id: { ...id2, description: "Slack\u2019s bot ID, such as B0123ABCD." },
  name: { ...nullableText2, description: "The bot\u2019s name." },
  appId: { ...nullableText2, description: "The app it belongs to (apps.id)." },
  isDeleted: { ...nullableBoolean2, description: "Whether it was removed." },
  updatedAt: {
    ...nullableTimestamp,
    description: "When Slack last changed the bot."
  }
};
var BotsStream = class extends SlackDesktopStream {
  name = "bots";
  primaryKey = ["workspaceId", "id"];
  jsonSchema = {
    type: "object",
    description: "One record per bot the app knows in a workspace, such as the sender of an integration\u2019s messages (messages.botId). Primary key workspaceId, id. One the app stops listing is deleted.",
    properties: properties2,
    required: Object.keys(properties2)
  };
  rows(scan) {
    return scan.clients.flatMap(({ workspace, bots }) => bots.map((bot2) => ({ workspaceId: workspace.id, bot: bot2 })));
  }
  records({ workspaceId, bot: bot2 }) {
    return [{ workspaceId, ...bot2 }];
  }
};

// packages/sources/slack/desktop/dist/streams/channel-members-stream.js
var { id: id3 } = slackFields;
var properties3 = {
  workspaceId: { ...id3, description: "The workspace (workspaces.id)." },
  channelId: { ...id3, description: "The conversation (channels.id)." },
  memberId: { ...id3, description: "A member of it (members.id)." }
};
var ChannelMembersStream = class extends SlackDesktopStream {
  name = "channelMembers";
  primaryKey = ["workspaceId", "channelId", "memberId"];
  jsonSchema = {
    type: "object",
    description: "One record per member of a conversation whose members the app keeps, which it does for group direct messages. Primary key workspaceId, channelId, memberId. A member the app stops listing is deleted.",
    properties: properties3,
    required: Object.keys(properties3)
  };
  rows(scan) {
    return scan.clients.flatMap(({ workspace, channels }) => channels.filter(({ id: id21 }) => scan.channelSelected(id21)).flatMap(({ id: channelId, memberIds }) => [...new Set(memberIds)].map((memberId) => ({
      workspaceId: workspace.id,
      channelId,
      memberId
    }))));
  }
  records(row) {
    return [row];
  }
};

// packages/sources/slack/desktop/dist/streams/channel-section-channels-stream.js
var { id: id4, ordinal } = slackFields;
var properties4 = {
  workspaceId: { ...id4, description: "The workspace (workspaces.id)." },
  sectionId: { ...id4, description: "The section (channelSections.id)." },
  channelId: { ...id4, description: "A conversation in it (channels.id)." },
  position: { ...ordinal, description: "Its place in the section, from 0." }
};
var ChannelSectionChannelsStream = class extends SlackDesktopStream {
  name = "channelSectionChannels";
  primaryKey = ["workspaceId", "sectionId", "channelId"];
  jsonSchema = {
    type: "object",
    description: "One record per conversation the user put in a sidebar section. Slack\u2019s own sections, which sort conversations themselves, list none. Primary key workspaceId, sectionId, channelId. One moved out is deleted.",
    properties: properties4,
    required: Object.keys(properties4)
  };
  rows(scan) {
    return scan.clients.flatMap(({ workspace, channelSections }) => channelSections.flatMap(({ id: sectionId, channelIds }) => [...new Set(channelIds)].map((channelId, position) => ({
      workspaceId: workspace.id,
      sectionId,
      channelId,
      position
    })).filter(({ channelId }) => scan.channelSelected(channelId))));
  }
  records(row) {
    return [row];
  }
};

// packages/sources/slack/desktop/dist/streams/channel-sections-stream.js
var { id: id5, ordinal: ordinal2, nullableText: nullableText3 } = slackFields;
var properties5 = {
  workspaceId: { ...id5, description: "The workspace (workspaces.id)." },
  id: { ...id5, description: "Slack\u2019s section ID." },
  type: {
    ...id5,
    description: "Slack\u2019s kind of section: standard for one the user made; channels, direct_messages, stars and the like for Slack\u2019s own."
  },
  name: {
    ...nullableText3,
    description: "The name the user gave it; NULL for Slack\u2019s own sections."
  },
  emoji: { ...nullableText3, description: "Its emoji." },
  position: {
    ...ordinal2,
    description: "Where the sidebar shows it, from 0 at the top."
  }
};
var ChannelSectionsStream = class extends SlackDesktopStream {
  name = "channelSections";
  primaryKey = ["workspaceId", "id"];
  jsonSchema = {
    type: "object",
    description: "One record per section of the user\u2019s sidebar in a workspace. Primary key workspaceId, id. One the user removes is deleted.",
    properties: properties5,
    required: Object.keys(properties5)
  };
  rows(scan) {
    return scan.clients.flatMap(({ workspace, channelSections }) => channelSections.map((section) => ({
      workspaceId: workspace.id,
      section
    })));
  }
  records({ workspaceId, section }) {
    return [
      {
        workspaceId,
        id: section.id,
        type: section.type,
        name: section.name,
        emoji: section.emoji,
        position: section.position
      }
    ];
  }
};

// packages/sources/slack/desktop/dist/streams/channels-stream.js
var { id: id6, nullableText: nullableText4, nullableBoolean: nullableBoolean3, nullableTimestamp: nullableTimestamp2, textList, nullableTs } = slackFields;
var properties6 = {
  workspaceId: { ...id6, description: "The workspace (workspaces.id)." },
  id: {
    ...id6,
    description: "Slack\u2019s conversation ID: C\u2026 for channels, G\u2026 for some private ones, D\u2026 for direct messages."
  },
  name: {
    ...nullableText4,
    description: "The channel\u2019s name without #; for a group direct message, Slack\u2019s generated mpdm- name."
  },
  kind: {
    type: "string",
    enum: ["public", "private", "im", "mpim"],
    description: "public or private channel, im (a direct message with one person) or mpim (a group direct message)."
  },
  imUserId: {
    ...nullableText4,
    description: "For an im, the other person (members.id)."
  },
  createdAt: { ...nullableTimestamp2, description: "When it was created." },
  creatorId: {
    ...nullableText4,
    description: "Who created it (members.id)."
  },
  updatedAt: {
    ...nullableTimestamp2,
    description: "When Slack last changed the channel itself."
  },
  isArchived: { ...nullableBoolean3, description: "Whether it is archived." },
  isGeneral: {
    ...nullableBoolean3,
    description: "Whether it is the workspace\u2019s general channel."
  },
  isMember: {
    ...nullableBoolean3,
    description: "Whether the signed-in user belongs to it."
  },
  isExternallyShared: {
    ...nullableBoolean3,
    description: "Whether it is shared with another organization (Slack Connect)."
  },
  isOrgShared: {
    ...nullableBoolean3,
    description: "Whether it is shared across workspaces of one organization."
  },
  topic: { ...nullableText4, description: "The channel\u2019s topic." },
  topicSetBy: {
    ...nullableText4,
    description: "Who set the topic (members.id)."
  },
  topicSetAt: { ...nullableTimestamp2, description: "When the topic was set." },
  purpose: { ...nullableText4, description: "The channel\u2019s description." },
  purposeSetBy: {
    ...nullableText4,
    description: "Who set the description (members.id)."
  },
  purposeSetAt: {
    ...nullableTimestamp2,
    description: "When the description was set."
  },
  previousNames: {
    ...textList,
    description: "Names the channel had before, newest first."
  },
  lastReadTs: {
    ...nullableTs,
    description: "The newest message the signed-in user has read (messages.ts); NULL when the app has none."
  },
  latestTs: {
    ...nullableTs,
    description: "The newest message in the channel as the app last heard (messages.ts), even when the app holds no messages of it."
  }
};
var ChannelsStream = class extends SlackDesktopStream {
  name = "channels";
  primaryKey = ["workspaceId", "id"];
  jsonSchema = {
    type: "object",
    description: "One record per conversation the app knows in a workspace: channels the user can see, direct messages and group direct messages. Primary key workspaceId, id. One the app stops listing is deleted.",
    properties: properties6,
    required: Object.keys(properties6)
  };
  rows(scan) {
    return scan.clients.flatMap(({ workspace, channels }) => channels.filter(({ id: id21 }) => scan.channelSelected(id21)).map((channel2) => ({ workspaceId: workspace.id, channel: channel2 })));
  }
  records({ workspaceId, channel: channel2 }) {
    return [
      {
        workspaceId,
        id: channel2.id,
        name: channel2.name,
        kind: channel2.kind,
        imUserId: channel2.imUserId,
        createdAt: channel2.createdAt,
        creatorId: channel2.creatorId,
        updatedAt: channel2.updatedAt,
        isArchived: channel2.isArchived,
        isGeneral: channel2.isGeneral,
        isMember: channel2.isMember,
        isExternallyShared: channel2.isExternallyShared,
        isOrgShared: channel2.isOrgShared,
        topic: channel2.topic.value,
        topicSetBy: channel2.topic.setBy,
        topicSetAt: channel2.topic.setAt,
        purpose: channel2.purpose.value,
        purposeSetBy: channel2.purpose.setBy,
        purposeSetAt: channel2.purpose.setAt,
        previousNames: [...channel2.previousNames],
        lastReadTs: channel2.lastReadTs,
        latestTs: channel2.latestTs
      }
    ];
  }
};

// packages/sources/slack/desktop/dist/streams/downloads-stream.js
import { statSync as statSync2 } from "node:fs";
var { id: id7, nullableText: nullableText5, nullableNumber, nullableTimestamp: nullableTimestamp3 } = slackFields;
var properties7 = {
  workspaceId: { ...id7, description: "The workspace (workspaces.id)." },
  fileId: {
    ...id7,
    description: "The file downloaded (files.id), held by the app or not."
  },
  url: {
    ...nullableText5,
    description: "Where the app downloaded it from, which needs Slack\u2019s sign-in."
  },
  userId: { ...nullableText5, description: "Who downloaded it (members.id)." },
  appVersion: {
    ...nullableText5,
    description: "The Slack app\u2019s version when it downloaded the file."
  },
  state: {
    ...nullableText5,
    description: "Slack\u2019s state for the download, such as completed."
  },
  progress: {
    ...nullableNumber,
    description: "How much of the file had downloaded, 1 when done."
  },
  startedAt: {
    ...nullableTimestamp3,
    description: "When the download started."
  },
  endedAt: { ...nullableTimestamp3, description: "When it finished." },
  path: {
    ...nullableText5,
    description: "Where the app saved the file, as recorded by Slack: its Downloads folder unless the user chose another place."
  }
};
var DownloadsStream = class extends SlackDesktopStream {
  name = "downloads";
  primaryKey = ["workspaceId", "fileId"];
  emitsDeletes = void 0;
  supportsFileTransfer = true;
  jsonSchema = {
    type: "object",
    description: "One record per file the Slack app downloaded, with the file while it is still where the app saved it. Primary key workspaceId, fileId. A download stays after the user clears Slack\u2019s list of downloads.",
    properties: properties7,
    required: Object.keys(properties7)
  };
  rows(scan) {
    return scan.downloads;
  }
  records(download) {
    return [{ ...download }];
  }
  // The original file, not a copy: downloads reach gigabytes and readers
  // only read it. One moved, deleted or out of this process's reach loads
  // no bytes.
  file({ path }) {
    if (path === null)
      return null;
    try {
      return statSync2(path).isFile() ? path : null;
    } catch {
      return null;
    }
  }
};

// packages/sources/slack/desktop/dist/streams/file-shares-stream.js
var { id: id8, ts: ts2, nullableText: nullableText6 } = slackFields;
var properties8 = {
  workspaceId: { ...id8, description: "The workspace (workspaces.id)." },
  fileId: { ...id8, description: "The file (files.id)." },
  channelId: {
    ...id8,
    description: "The conversation it was shared in (channels.id)."
  },
  ts: {
    ...ts2,
    description: "The message that shared it (messages.ts), held by the app or not."
  },
  isPrivate: {
    type: "boolean",
    description: "Whether the conversation is private."
  },
  sharedBy: { ...nullableText6, description: "Who shared it (members.id)." }
};
var FileSharesStream = class extends SlackDesktopStream {
  name = "fileShares";
  primaryKey = ["workspaceId", "fileId", "channelId", "ts"];
  emitsDeletes = void 0;
  jsonSchema = {
    type: "object",
    description: "One record per place a file was shared: the conversation and the message that shared it, including messages the app does not hold. Primary key workspaceId, fileId, channelId, ts. Kept after the app drops the file.",
    properties: properties8,
    required: Object.keys(properties8)
  };
  rows(scan) {
    return scan.clients.flatMap(({ workspace, files }) => files.flatMap(({ id: fileId, shares }) => shares.filter(({ channelId }) => scan.channelSelected(channelId)).map((share) => ({ workspaceId: workspace.id, fileId, share }))));
  }
  records({ share, ...row }) {
    return [{ ...row, ...share }];
  }
};

// packages/sources/slack/desktop/dist/streams/files-stream.js
var { id: id9, nullableText: nullableText7, nullableBoolean: nullableBoolean4, nullableInteger, nullableTimestamp: nullableTimestamp4 } = slackFields;
var properties9 = {
  workspaceId: { ...id9, description: "The workspace (workspaces.id)." },
  id: { ...id9, description: "Slack\u2019s file ID, such as F0123ABCD." },
  name: { ...nullableText7, description: "The file\u2019s name." },
  title: { ...nullableText7, description: "The title shown for it." },
  mimetype: { ...nullableText7, description: "Its MIME type." },
  filetype: {
    ...nullableText7,
    description: "Slack\u2019s file type, such as pdf, png, markdown or list."
  },
  prettyType: { ...nullableText7, description: "The type as Slack shows it." },
  mode: {
    ...nullableText7,
    description: "hosted (uploaded), external, snippet, post, canvas or list (a Slack List, its rows in list_records)."
  },
  size: { ...nullableInteger, description: "Its size in bytes." },
  userId: { ...nullableText7, description: "Who shared it (members.id)." },
  createdAt: { ...nullableTimestamp4, description: "When it was created." },
  updatedAt: { ...nullableTimestamp4, description: "When it last changed." },
  editedAt: { ...nullableTimestamp4, description: "When it was last edited." },
  isExternal: {
    ...nullableBoolean4,
    description: "Whether it lives in another service."
  },
  externalType: {
    ...nullableText7,
    description: "The service an external file lives in."
  },
  isPublic: {
    ...nullableBoolean4,
    description: "Whether it is shared in a public channel."
  },
  isDeleted: { ...nullableBoolean4, description: "Whether it was deleted." },
  isTombstoned: {
    ...nullableBoolean4,
    description: "Whether Slack keeps only a placeholder of it."
  },
  urlPrivate: {
    ...nullableText7,
    description: "Its download address, which needs Slack\u2019s sign-in; the app keeps no copy of the bytes."
  },
  permalink: { ...nullableText7, description: "Its page in Slack." },
  preview: {
    ...nullableText7,
    description: "The first lines of a text file or snippet."
  },
  content: {
    ...nullableText7,
    description: "A snippet\u2019s whole text, which the app keeps with it; NULL for other files."
  },
  lines: { ...nullableInteger, description: "A text file\u2019s line count." },
  durationMs: {
    ...nullableInteger,
    description: "A recording\u2019s length in milliseconds."
  },
  width: { ...nullableInteger, description: "An image or video\u2019s width." },
  height: { ...nullableInteger, description: "An image or video\u2019s height." },
  listMetadata: {
    ...nullableText7,
    description: "For a List, its columns (schema) and views as JSON, as Slack holds them."
  },
  transcription: {
    ...nullableText7,
    description: "For a recording, its transcript as JSON."
  }
};
var FilesStream = class extends SlackDesktopStream {
  name = "files";
  primaryKey = ["workspaceId", "id"];
  emitsDeletes = void 0;
  jsonSchema = {
    type: "object",
    description: "One record per file the app has held: uploads, snippets, canvases and Lists, metadata only (the app keeps no bytes). Primary key workspaceId, id. A file stays after the app drops it from its cache; one deleted while held reads isDeleted or isTombstoned.",
    properties: properties9,
    required: Object.keys(properties9)
  };
  rows(scan) {
    return scan.clients.flatMap(({ workspace, files }) => files.map((file2) => ({ workspaceId: workspace.id, file: file2 })));
  }
  records({ workspaceId, file: file2 }) {
    return [
      {
        workspaceId,
        id: file2.id,
        name: file2.name,
        title: file2.title,
        mimetype: file2.mimetype,
        filetype: file2.filetype,
        prettyType: file2.prettyType,
        mode: file2.mode,
        size: file2.size,
        userId: file2.userId,
        createdAt: file2.createdAt,
        updatedAt: file2.updatedAt,
        editedAt: file2.editedAt,
        isExternal: file2.isExternal,
        externalType: file2.externalType,
        isPublic: file2.isPublic,
        isDeleted: file2.isDeleted,
        isTombstoned: file2.isTombstoned,
        urlPrivate: file2.urlPrivate,
        permalink: file2.permalink,
        preview: file2.preview,
        content: file2.content,
        lines: file2.lines,
        durationMs: file2.durationMs,
        width: file2.width,
        height: file2.height,
        listMetadata: file2.listMetadataJson,
        transcription: file2.transcriptionJson
      }
    ];
  }
};

// packages/sources/slack/desktop/dist/streams/list-records-stream.js
var { id: id10, nullableText: nullableText8, nullableBoolean: nullableBoolean5, nullableTimestamp: nullableTimestamp5, nullableTs: nullableTs2 } = slackFields;
var properties10 = {
  workspaceId: { ...id10, description: "The workspace (workspaces.id)." },
  listId: { ...id10, description: "The List (files.id, mode list)." },
  id: { ...id10, description: "Slack\u2019s row ID, such as Rec0123ABCD." },
  position: {
    ...nullableText8,
    description: "The row\u2019s sort key in the List; order rows by it as text."
  },
  parentRecordId: {
    ...nullableText8,
    description: "For a subtask, its parent row (list_records.id)."
  },
  threadTs: {
    ...nullableTs2,
    description: "The thread of comments on the row, as a ts."
  },
  createdAt: { ...nullableTimestamp5, description: "When the row was added." },
  createdBy: { ...nullableText8, description: "Who added it (members.id)." },
  updatedAt: {
    ...nullableTimestamp5,
    description: "When it last changed."
  },
  updatedBy: {
    ...nullableText8,
    description: "Who last changed it (members.id)."
  },
  isArchived: { ...nullableBoolean5, description: "Whether it was archived." },
  fields: {
    ...nullableText8,
    description: "Its cells as JSON keyed by column ID, as Slack holds them; files.listMetadata names each column under schema."
  }
};
var ListRecordsStream = class extends SlackDesktopStream {
  name = "listRecords";
  primaryKey = ["workspaceId", "listId", "id"];
  emitsDeletes = void 0;
  jsonSchema = {
    type: "object",
    description: "One record per row of a Slack List the app has opened. Primary key workspaceId, listId, id. A row stays after the app drops it; one archived while held reads isArchived.",
    properties: properties10,
    required: Object.keys(properties10)
  };
  rows(scan) {
    return scan.clients.flatMap(({ workspace, listRecords: listRecords2 }) => listRecords2.map((record) => ({ workspaceId: workspace.id, record })));
  }
  records({ workspaceId, record }) {
    return [
      {
        workspaceId,
        listId: record.listId,
        id: record.id,
        position: record.position,
        parentRecordId: record.parentRecordId,
        threadTs: record.threadTs,
        createdAt: record.createdAt,
        createdBy: record.createdBy,
        updatedAt: record.updatedAt,
        updatedBy: record.updatedBy,
        isArchived: record.isArchived,
        fields: record.fieldsJson
      }
    ];
  }
};

// packages/sources/slack/desktop/dist/streams/members-stream.js
var { id: id11, nullableText: nullableText9, nullableBoolean: nullableBoolean6, nullableTimestamp: nullableTimestamp6 } = slackFields;
var properties11 = {
  workspaceId: { ...id11, description: "The workspace (workspaces.id)." },
  id: { ...id11, description: "Slack\u2019s member ID, such as U0123ABCD." },
  teamId: {
    ...nullableText9,
    description: "The workspace the member belongs to; another workspace\u2019s ID for someone from a shared channel."
  },
  name: { ...nullableText9, description: "The member\u2019s username." },
  realName: { ...nullableText9, description: "The member\u2019s full name." },
  displayName: {
    ...nullableText9,
    description: "The name the member chose to show."
  },
  firstName: { ...nullableText9, description: "First name." },
  lastName: { ...nullableText9, description: "Last name." },
  title: { ...nullableText9, description: "Job title." },
  email: { ...nullableText9, description: "Email address." },
  phone: { ...nullableText9, description: "Phone number." },
  pronouns: { ...nullableText9, description: "Pronouns." },
  timeZone: {
    ...nullableText9,
    description: "IANA time zone, such as Europe/London."
  },
  statusText: { ...nullableText9, description: "Custom status text." },
  statusEmoji: {
    ...nullableText9,
    description: "Custom status emoji, such as :palm_tree:."
  },
  statusExpiresAt: {
    ...nullableTimestamp6,
    description: "When the custom status clears; NULL when it does not."
  },
  avatarUrl: { ...nullableText9, description: "Profile picture URL, 192 px." },
  botId: {
    ...nullableText9,
    description: "For a bot user, its bot (bots.id)."
  },
  appId: {
    ...nullableText9,
    description: "For an app\u2019s user, its app (apps.id)."
  },
  isBot: { ...nullableBoolean6, description: "Whether it is a bot." },
  isAppUser: {
    ...nullableBoolean6,
    description: "Whether it is an app\u2019s user."
  },
  isDeleted: {
    ...nullableBoolean6,
    description: "Whether the member was deactivated."
  },
  isAdmin: { ...nullableBoolean6, description: "Whether a workspace admin." },
  isOwner: { ...nullableBoolean6, description: "Whether a workspace owner." },
  isPrimaryOwner: {
    ...nullableBoolean6,
    description: "Whether the primary owner."
  },
  isRestricted: {
    ...nullableBoolean6,
    description: "Whether a guest limited to some channels."
  },
  isUltraRestricted: {
    ...nullableBoolean6,
    description: "Whether a guest limited to one channel."
  },
  isInvited: {
    ...nullableBoolean6,
    description: "Whether invited and not yet joined."
  },
  isSelf: {
    ...nullableBoolean6,
    description: "Whether it is the signed-in user."
  },
  updatedAt: {
    ...nullableTimestamp6,
    description: "When Slack last changed the member\u2019s profile."
  }
};
var MembersStream = class extends SlackDesktopStream {
  name = "members";
  primaryKey = ["workspaceId", "id"];
  jsonSchema = {
    type: "object",
    description: "One record per person, bot or app user the app knows in a workspace. Primary key workspaceId, id. One the app stops listing is deleted; a deactivated member stays with isDeleted.",
    properties: properties11,
    required: Object.keys(properties11)
  };
  rows(scan) {
    return scan.clients.flatMap(({ workspace, members }) => members.map((member2) => ({ workspaceId: workspace.id, member: member2 })));
  }
  records({ workspaceId, member: member2 }) {
    return [{ workspaceId, ...member2 }];
  }
};

// packages/sources/slack/desktop/dist/streams/message-attachments-stream.js
var { id: id12, ts: ts3, ordinal: ordinal3, nullableText: nullableText10, nullableBoolean: nullableBoolean7 } = slackFields;
var properties12 = {
  workspaceId: { ...id12, description: "The workspace (workspaces.id)." },
  channelId: { ...id12, description: "The conversation (channels.id)." },
  messageTs: { ...ts3, description: "The message it is under (messages.ts)." },
  position: {
    ...ordinal3,
    description: "Its place under the message, from 0."
  },
  attachmentId: { ...nullableText10, description: "Slack\u2019s ID for it." },
  fallback: {
    ...nullableText10,
    description: "Its plain-text summary."
  },
  pretext: { ...nullableText10, description: "Text shown above it." },
  text: { ...nullableText10, description: "Its text." },
  fromUrl: {
    ...nullableText10,
    description: "The link it previews, for a link unfurl."
  },
  authorId: {
    ...nullableText10,
    description: "For a shared message, who wrote it (members.id)."
  },
  authorName: { ...nullableText10, description: "Its author\u2019s name." },
  authorLink: { ...nullableText10, description: "Its author\u2019s link." },
  sharedChannelId: {
    ...nullableText10,
    description: "For a shared message, the conversation it came from."
  },
  sharedMessageTs: {
    ...nullableText10,
    description: "For a shared message, its ts there."
  },
  footer: { ...nullableText10, description: "Its footer." },
  color: { ...nullableText10, description: "The color of its side bar." },
  appId: { ...nullableText10, description: "The app that added it (apps.id)." },
  botId: { ...nullableText10, description: "The bot that added it (bots.id)." },
  isMessageUnfurl: {
    ...nullableBoolean7,
    description: "Whether it previews another Slack message."
  },
  isAppUnfurl: {
    ...nullableBoolean7,
    description: "Whether an app added the preview."
  },
  fields: {
    ...nullableText10,
    description: "Its title/value fields as JSON, as Slack holds them."
  },
  blocks: {
    ...nullableText10,
    description: "Its Block Kit blocks as JSON, as Slack holds them."
  }
};
var MessageAttachmentsStream = class extends SlackDesktopStream {
  name = "messageAttachments";
  primaryKey = ["workspaceId", "channelId", "messageTs", "position"];
  jsonSchema = {
    type: "object",
    description: "One record per attachment Slack shows under a message: link previews, shared messages and integrations\u2019 cards. Primary key workspaceId, channelId, messageTs, position. Kept and deleted with their message.",
    properties: properties12,
    required: Object.keys(properties12)
  };
  covers(scan, key) {
    return scan.holds(key.workspaceId, key.channelId, key.messageTs);
  }
  rows(scan) {
    return scan.clients.flatMap((client) => scan.messages(client).flatMap(({ channelId, ts: ts9, attachments }) => attachments.map((attachment2, position) => ({
      workspaceId: client.workspace.id,
      channelId,
      messageTs: ts9,
      position,
      attachment: attachment2
    }))));
  }
  records({ attachment: attachment2, ...row }) {
    return [
      {
        ...row,
        attachmentId: attachment2.id,
        fallback: attachment2.fallback,
        pretext: attachment2.pretext,
        text: attachment2.text,
        fromUrl: attachment2.fromUrl,
        authorId: attachment2.authorId,
        authorName: attachment2.authorName,
        authorLink: attachment2.authorLink,
        sharedChannelId: attachment2.channelId,
        sharedMessageTs: attachment2.messageTs,
        footer: attachment2.footer,
        color: attachment2.color,
        appId: attachment2.appId,
        botId: attachment2.botId,
        isMessageUnfurl: attachment2.isMessageUnfurl,
        isAppUnfurl: attachment2.isAppUnfurl,
        fields: attachment2.fieldsJson,
        blocks: attachment2.blocksJson
      }
    ];
  }
};

// packages/sources/slack/desktop/dist/streams/message-files-stream.js
var { id: id13, ts: ts4, ordinal: ordinal4 } = slackFields;
var properties13 = {
  workspaceId: { ...id13, description: "The workspace (workspaces.id)." },
  channelId: { ...id13, description: "The conversation (channels.id)." },
  messageTs: { ...ts4, description: "The message (messages.ts)." },
  position: { ...ordinal4, description: "Its place in the message, from 0." },
  fileId: { ...id13, description: "The file (files.id)." }
};
var MessageFilesStream = class extends SlackDesktopStream {
  name = "messageFiles";
  primaryKey = ["workspaceId", "channelId", "messageTs", "position"];
  jsonSchema = {
    type: "object",
    description: "One record per file a message shares, in the message\u2019s order. Primary key workspaceId, channelId, messageTs, position. Kept and deleted with their message.",
    properties: properties13,
    required: Object.keys(properties13)
  };
  covers(scan, key) {
    return scan.holds(key.workspaceId, key.channelId, key.messageTs);
  }
  rows(scan) {
    return scan.clients.flatMap((client) => scan.messages(client).flatMap(({ channelId, ts: ts9, fileIds }) => fileIds.map((fileId, position) => ({
      workspaceId: client.workspace.id,
      channelId,
      messageTs: ts9,
      position,
      fileId
    }))));
  }
  records(row) {
    return [row];
  }
};

// packages/sources/slack/desktop/dist/streams/message-reactions-stream.js
var { id: id14, ts: ts5, nullableText: nullableText11, textList: textList2 } = slackFields;
var properties14 = {
  workspaceId: { ...id14, description: "The workspace (workspaces.id)." },
  channelId: { ...id14, description: "The conversation (channels.id)." },
  messageTs: { ...ts5, description: "The message (messages.ts)." },
  name: {
    ...id14,
    description: "The emoji, as Slack names it, with any skin tone: thumbsup::skin-tone-2."
  },
  baseName: {
    ...nullableText11,
    description: "The emoji without its skin tone."
  },
  count: {
    type: "integer",
    minimum: 1,
    description: "How many people reacted with it."
  },
  userIds: {
    ...textList2,
    description: "Who reacted (members.id), as far as the app knows: on a busy message, fewer than count."
  }
};
var MessageReactionsStream = class extends SlackDesktopStream {
  name = "messageReactions";
  primaryKey = ["workspaceId", "channelId", "messageTs", "name"];
  jsonSchema = {
    type: "object",
    description: "One record per emoji reaction on a message. Primary key workspaceId, channelId, messageTs, name. A reaction removed from a message the app still holds is deleted; reactions of a message the app dropped from its cache stay.",
    properties: properties14,
    required: Object.keys(properties14)
  };
  covers(scan, key) {
    return scan.holds(key.workspaceId, key.channelId, key.messageTs);
  }
  rows(scan) {
    return scan.clients.flatMap((client) => scan.messages(client).flatMap(({ channelId, ts: ts9, reactions }) => reactions.map((reaction2) => ({
      workspaceId: client.workspace.id,
      channelId,
      messageTs: ts9,
      reaction: reaction2
    }))));
  }
  records({ reaction: reaction2, ...row }) {
    return [{ ...row, ...reaction2, userIds: [...reaction2.userIds] }];
  }
};

// packages/sources/slack/desktop/dist/streams/message-fields.js
var { id: id15, ts: ts6, instant: instant2, nullableText: nullableText12, nullableBoolean: nullableBoolean8, nullableInteger: nullableInteger2, nullableTs: nullableTs3, textList: textList3 } = slackFields;
var messageProperties = {
  workspaceId: { ...id15, description: "The workspace (workspaces.id)." },
  channelId: { ...id15, description: "The conversation (channels.id)." },
  ts: {
    ...ts6,
    description: "Slack\u2019s ID for the message within its conversation, the time it was sent as seconds.microseconds, such as 1712345678.123456."
  },
  sentAt: { ...instant2, description: "When it was sent: ts as an instant." },
  type: { ...id15, description: "Slack\u2019s message type, almost always message." },
  subtype: {
    ...nullableText12,
    description: "What kind of message, such as channel_join or thread_broadcast (a reply also sent to the channel); NULL for an ordinary message."
  },
  userId: { ...nullableText12, description: "Who sent it (members.id)." },
  botId: { ...nullableText12, description: "The bot that sent it (bots.id)." },
  text: {
    ...nullableText12,
    description: "The message in Slack\u2019s markup: <@U\u2026> mentions, <#C\u2026> channels, <url|label> links."
  },
  threadTs: {
    ...nullableTs3,
    description: "The thread it starts or belongs to (messages.ts of the parent); equal to ts for a parent."
  },
  replyCount: {
    ...nullableInteger2,
    description: "For a thread parent, how many replies it has."
  },
  replyUserIds: {
    ...textList3,
    description: "For a thread parent, who replied (members.id)."
  },
  latestReplyTs: {
    ...nullableTs3,
    description: "For a thread parent, its newest reply\u2019s ts."
  },
  editedBy: {
    ...nullableText12,
    description: "Who last edited it (members.id)."
  },
  editedTs: {
    ...nullableTs3,
    description: "When it was last edited, as a ts; NULL when never edited."
  },
  clientMessageId: {
    ...nullableText12,
    description: "The ID the sending app gave the message."
  },
  isLocked: {
    ...nullableBoolean8,
    description: "Whether its thread is locked to new replies."
  },
  isBeyondPlanLimit: {
    ...nullableBoolean8,
    description: "Whether the workspace\u2019s plan hides it, past the free plan\u2019s history limit."
  },
  savedState: {
    ...nullableText12,
    description: "For a message the user saved for later, its state in their Later list, such as in_progress; NULL when not saved."
  },
  savedTodoState: {
    ...nullableText12,
    description: "For a message saved for later, Slack\u2019s to-do state for it, such as saved."
  },
  isSavedArchived: {
    ...nullableBoolean8,
    description: "For a message saved for later, whether the user archived it in their Later list."
  },
  blocks: {
    ...nullableText12,
    description: "The message\u2019s Block Kit blocks as JSON, as Slack holds them: rich text with its formatting, sections, buttons."
  }
};
function messageRecord(workspaceId, message2) {
  return {
    workspaceId,
    channelId: message2.channelId,
    ts: message2.ts,
    sentAt: message2.sentAt,
    type: message2.type,
    subtype: message2.subtype,
    userId: message2.userId,
    botId: message2.botId,
    text: message2.text,
    threadTs: message2.threadTs,
    replyCount: message2.replyCount,
    replyUserIds: [...message2.replyUserIds],
    latestReplyTs: message2.latestReplyTs,
    editedBy: message2.editedBy,
    editedTs: message2.editedTs,
    clientMessageId: message2.clientMessageId,
    isLocked: message2.isLocked,
    isBeyondPlanLimit: message2.isBeyondPlanLimit,
    savedState: message2.savedState,
    savedTodoState: message2.savedTodoState,
    isSavedArchived: message2.isSavedArchived,
    blocks: message2.blocksJson
  };
}

// packages/sources/slack/desktop/dist/streams/messages-stream.js
var MessagesStream = class extends SlackDesktopStream {
  name = "messages";
  primaryKey = ["workspaceId", "channelId", "ts"];
  jsonSchema = {
    type: "object",
    description: "One record per channel message the app has held: the app keeps only the parts of each conversation it loaded, so older history is here only if it was loaded while this import ran. Thread replies are in threadReplies. Primary key workspaceId, channelId, ts. A message the app no longer lists inside a part of the conversation it still holds was deleted and is deleted here; one the app dropped from its cache stays.",
    properties: messageProperties,
    required: Object.keys(messageProperties)
  };
  covers(scan, key) {
    return scan.holds(key.workspaceId, key.channelId, key.ts);
  }
  rows(scan) {
    return scan.clients.flatMap((client) => scan.messages(client).map((message2) => ({ workspaceId: client.workspace.id, message: message2 })));
  }
  records({ workspaceId, message: message2 }) {
    return [messageRecord(workspaceId, message2)];
  }
};

// packages/sources/slack/desktop/dist/streams/pins-stream.js
var { id: id16, ts: ts7, nullableText: nullableText13, nullableTimestamp: nullableTimestamp7 } = slackFields;
var properties15 = {
  workspaceId: { ...id16, description: "The workspace (workspaces.id)." },
  channelId: {
    ...id16,
    description: "The conversation it is pinned in (channels.id)."
  },
  ts: {
    ...ts7,
    description: "The pinned message (messages.ts), held by the app or not."
  },
  type: { ...id16, description: "What is pinned: message." },
  pinnedBy: {
    ...nullableText13,
    description: "Who pinned it (members.id); NULL when the app holds neither the conversation\u2019s pin list with the message nor the message."
  },
  pinnedAt: {
    ...nullableTimestamp7,
    description: "When it was pinned; NULL as pinnedBy."
  }
};
var PinsStream = class extends SlackDesktopStream {
  name = "pins";
  primaryKey = ["workspaceId", "channelId", "ts"];
  jsonSchema = {
    type: "object",
    description: "One record per message pinned in a conversation, as far as the app knows the conversation\u2019s pins. Primary key workspaceId, channelId, ts. A pin removed from a conversation whose pin list the app loaded is deleted; pins of a conversation it never loaded the list of stay.",
    properties: properties15,
    required: Object.keys(properties15)
  };
  covers(scan, key) {
    return scan.holdsPins(key.workspaceId, key.channelId);
  }
  rows(scan) {
    return scan.clients.flatMap(({ workspace, pins: pins2 }) => pins2.filter(({ channelId }) => scan.channelSelected(channelId)).map((pin) => ({ workspaceId: workspace.id, pin })));
  }
  records({ workspaceId, pin }) {
    return [{ workspaceId, ...pin }];
  }
};

// packages/sources/slack/desktop/dist/streams/preferences-stream.js
var { id: id17 } = slackFields;
var properties16 = {
  workspaceId: { ...id17, description: "The workspace (workspaces.id)." },
  scope: {
    type: "string",
    enum: ["user", "team"],
    description: "user for the signed-in user\u2019s own preference, team for the workspace\u2019s as its admins set it."
  },
  name: {
    ...id17,
    description: "Slack\u2019s name for the preference, such as tz or time24."
  },
  value: {
    type: "string",
    description: "Its value as JSON, as Slack holds it."
  }
};
var PreferencesStream = class extends SlackDesktopStream {
  name = "preferences";
  primaryKey = ["workspaceId", "scope", "name"];
  jsonSchema = {
    type: "object",
    description: "One record per preference the app holds for a workspace: the user\u2019s settings and the workspace\u2019s. Primary key workspaceId, scope, name. One the app stops holding is deleted.",
    properties: properties16,
    required: Object.keys(properties16)
  };
  rows(scan) {
    return scan.clients.flatMap(({ workspace, preferences: preferences2 }) => preferences2.map((preference) => ({
      workspaceId: workspace.id,
      preference
    })));
  }
  records({ workspaceId, preference }) {
    return [
      {
        workspaceId,
        scope: preference.scope,
        name: preference.name,
        value: preference.valueJson
      }
    ];
  }
};

// packages/sources/slack/desktop/dist/streams/thread-replies-stream.js
var ThreadRepliesStream = class extends SlackDesktopStream {
  name = "threadReplies";
  primaryKey = ["workspaceId", "channelId", "ts"];
  emitsDeletes = void 0;
  jsonSchema = {
    type: "object",
    description: "One record per thread reply the app has held, which it loads when a thread is opened; threadTs is the parent in messages. Primary key workspaceId, channelId, ts. A reply stays after the app drops it, whether it was deleted or only left the cache: the app records no range of a thread to tell the two apart.",
    properties: messageProperties,
    required: Object.keys(messageProperties)
  };
  rows(scan) {
    return scan.clients.flatMap((client) => scan.threadReplies(client).map((message2) => ({ workspaceId: client.workspace.id, message: message2 })));
  }
  records({ workspaceId, message: message2 }) {
    return [messageRecord(workspaceId, message2)];
  }
};

// packages/sources/slack/desktop/dist/streams/thread-subscriptions-stream.js
var { id: id18, ts: ts8, nullableBoolean: nullableBoolean9, nullableTs: nullableTs4 } = slackFields;
var properties17 = {
  workspaceId: { ...id18, description: "The workspace (workspaces.id)." },
  channelId: { ...id18, description: "The conversation (channels.id)." },
  threadTs: { ...ts8, description: "The thread\u2019s parent (messages.ts)." },
  isSubscribed: {
    ...nullableBoolean9,
    description: "Whether the user follows the thread."
  },
  lastReadTs: {
    ...nullableTs4,
    description: "The newest reply the user has read, as a ts."
  }
};
var ThreadSubscriptionsStream = class extends SlackDesktopStream {
  name = "threadSubscriptions";
  primaryKey = ["workspaceId", "channelId", "threadTs"];
  jsonSchema = {
    type: "object",
    description: "One record per thread the app knows whether the user follows. Primary key workspaceId, channelId, threadTs. One the app stops listing is deleted.",
    properties: properties17,
    required: Object.keys(properties17)
  };
  rows(scan) {
    return scan.clients.flatMap(({ workspace, threadSubscriptions }) => threadSubscriptions.filter(({ channelId }) => scan.channelSelected(channelId)).map((subscription) => ({ workspaceId: workspace.id, subscription })));
  }
  records({ workspaceId, subscription }) {
    return [{ workspaceId, ...subscription }];
  }
};

// packages/sources/slack/desktop/dist/streams/user-group-memberships-stream.js
var { id: id19, nullableBoolean: nullableBoolean10 } = slackFields;
var properties18 = {
  workspaceId: { ...id19, description: "The workspace (workspaces.id)." },
  userGroupId: {
    ...id19,
    description: "Slack\u2019s user group ID, such as S0123ABCD."
  },
  isMember: {
    ...nullableBoolean10,
    description: "Whether the signed-in user is in the group."
  }
};
var UserGroupMembershipsStream = class extends SlackDesktopStream {
  name = "userGroupMemberships";
  primaryKey = ["workspaceId", "userGroupId"];
  emitsDeletes = void 0;
  jsonSchema = {
    type: "object",
    description: "One record per user group the app checked the signed-in user\u2019s membership of. The app keeps neither the groups\u2019 names nor their members. Primary key workspaceId, userGroupId. A group stays after the app forgets its check.",
    properties: properties18,
    required: Object.keys(properties18)
  };
  rows(scan) {
    return scan.clients.flatMap(({ workspace, userGroupMemberships }) => userGroupMemberships.map((membership) => ({
      workspaceId: workspace.id,
      membership
    })));
  }
  records({ workspaceId, membership }) {
    return [{ workspaceId, ...membership }];
  }
};

// packages/sources/slack/desktop/dist/streams/workspaces-stream.js
var { id: id20, nullableText: nullableText14, nullableTimestamp: nullableTimestamp8 } = slackFields;
var properties19 = {
  id: { ...id20, description: "Slack\u2019s workspace (team) ID, such as T0123ABCD." },
  name: { ...id20, description: "The workspace\u2019s name." },
  domain: {
    ...id20,
    description: "The workspace\u2019s subdomain: <domain>.slack.com."
  },
  url: { ...nullableText14, description: "The workspace\u2019s address." },
  emailDomain: {
    ...nullableText14,
    description: "The email domain that may join the workspace on its own."
  },
  plan: {
    ...nullableText14,
    description: "Slack\u2019s code for the workspace\u2019s plan, such as plus; NULL for the free plan."
  },
  createdAt: {
    ...nullableTimestamp8,
    description: "When the workspace was created."
  },
  iconUrl: { ...nullableText14, description: "The workspace icon\u2019s URL." },
  userId: {
    ...id20,
    description: "The member ID this Mac is signed in to the workspace as."
  }
};
var WorkspacesStream = class extends SlackDesktopStream {
  name = "workspaces";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One record per Slack workspace the app is signed in to on this Mac and has saved. Primary key id. A workspace the app no longer keeps, such as one signed out of, stays.",
    properties: properties19,
    required: Object.keys(properties19)
  };
  covers(scan, key) {
    return scan.keeps(key.id);
  }
  rows(scan) {
    return scan.clients;
  }
  records({ workspace, userId }) {
    return [{ ...workspace, userId }];
  }
};

// packages/sources/slack/desktop/dist/slack-desktop-source.js
var readers = {
  workspaces: new WorkspacesStream(),
  channels: new ChannelsStream(),
  channelMembers: new ChannelMembersStream(),
  members: new MembersStream(),
  bots: new BotsStream(),
  apps: new AppsStream(),
  messages: new MessagesStream(),
  threadReplies: new ThreadRepliesStream(),
  messageAttachments: new MessageAttachmentsStream(),
  messageReactions: new MessageReactionsStream(),
  messageFiles: new MessageFilesStream(),
  pins: new PinsStream(),
  files: new FilesStream(),
  fileShares: new FileSharesStream(),
  listRecords: new ListRecordsStream(),
  channelSections: new ChannelSectionsStream(),
  channelSectionChannels: new ChannelSectionChannelsStream(),
  threadSubscriptions: new ThreadSubscriptionsStream(),
  preferences: new PreferencesStream(),
  userGroupMemberships: new UserGroupMembershipsStream(),
  downloads: new DownloadsStream()
};
var catalog = new Catalog(Object.values(readers).map((reader) => reader.describe()));
var readersByName = new Map(Object.values(readers).map((reader) => [reader.name, reader]));
var pollIntervalMs = 1e3;
var SlackDesktopSource = class extends Source {
  identity;
  catalog = catalog;
  workspaces = readers.workspaces.describe();
  channels = readers.channels.describe();
  channelMembers = readers.channelMembers.describe();
  members = readers.members.describe();
  bots = readers.bots.describe();
  apps = readers.apps.describe();
  messages = readers.messages.describe();
  threadReplies = readers.threadReplies.describe();
  messageAttachments = readers.messageAttachments.describe();
  messageReactions = readers.messageReactions.describe();
  messageFiles = readers.messageFiles.describe();
  pins = readers.pins.describe();
  files = readers.files.describe();
  fileShares = readers.fileShares.describe();
  listRecords = readers.listRecords.describe();
  channelSections = readers.channelSections.describe();
  channelSectionChannels = readers.channelSectionChannels.describe();
  threadSubscriptions = readers.threadSubscriptions.describe();
  preferences = readers.preferences.describe();
  userGroupMemberships = readers.userGroupMemberships.describe();
  downloads = readers.downloads.describe();
  directory;
  scope;
  #store;
  constructor(directory = slackDesktopDirectory(), scope = {}) {
    super();
    this.directory = directory;
    this.scope = scope;
    this.#store = new SlackDesktopStore(directory);
    this.identity = `slack-desktop:${directory}`;
    Object.freeze(this);
  }
  async open() {
    const [clients, downloads] = await Promise.allSettled([
      this.#store.clients(),
      this.#store.downloads()
    ]);
    return new SlackDesktopScan(clients, downloads, this.scope);
  }
  failureType(error) {
    return error instanceof SlackDesktopUnavailableError ? "config" : "system";
  }
  coverage(_stream) {
    return {
      description: "What the Slack app keeps on this Mac for each signed-in workspace: its channels, members and apps, only the messages the app has loaded, and the files it downloaded. A workspace appears once the app has saved it, every few minutes while it is open and when it quits.",
      selection: this.scope
    };
  }
  // The app saves one record for all of a workspace, so a save wakes every
  // selected stream; the snapshot diff writes nothing for those that did not
  // change.
  async *observe({ streams, signal }) {
    if (signal.aborted)
      return;
    let seen = this.#store.version();
    yield streams;
    try {
      for await (const _ of setInterval(pollIntervalMs, void 0, {
        signal
      })) {
        const current = this.#store.version();
        const changed = current === seen ? [] : streams;
        seen = current;
        yield changed;
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError"))
        throw error;
    }
  }
  async *extract(configuration, state, _partition, scan) {
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === void 0)
      throw new Error(`Slack has no stream ${stream.name}`);
    const records = reader.read(scan);
    const messages = configuration.syncMode === "full_refresh" ? records.map((data) => ({ stream: stream.name, data })) : diffSnapshot(stream, records, state, stream.emitsDeletes ? { covers: ({ key }) => reader.covers(scan, key) } : {});
    for await (const message2 of messages)
      if ("type" in message2 || configuration.fileReads.length === 0)
        yield message2;
      else
        yield { ...message2, file: reader.file(message2.data) };
  }
};

// packages/connectors/apple/slack/dist/slack-connector.js
var conversation = (row, rows) => {
  const workspace = rows.get("workspaces")?.find(({ id: id21 }) => id21 === row.workspaceId);
  const label = conversationLabel(row);
  return workspace === void 0 ? label : `${name(workspace)} / ${label}`;
};
function conversationLabel(row) {
  if (row.kind === "im")
    return `direct message ${String(row.imUserId)}`;
  if (row.kind === "mpim")
    return name(row);
  return `#${name(row)}`;
}
var SlackConnector = class extends AppleConnector {
  datedBy = "date sent";
  fullDiskAccess = true;
  note = "Slack keeps only the messages it has loaded on this Mac, so older history is imported only once Slack loads it.";
  choices = [
    {
      stream: "workspaces",
      scope: "accountIds",
      title: "workspaces",
      id: byId,
      label: name
    },
    {
      stream: "channels",
      scope: "collectionIds",
      title: "conversations",
      id: byId,
      label: conversation
    }
  ];
  unscoped = [];
  storeCopies = [];
  access() {
    return "Open Slack in each workspace to import and let it run: it saves what it has loaded every few minutes and when it quits, and only messages it has loaded on this Mac are imported.";
  }
  source(scope) {
    return new SlackDesktopSource(void 0, scope);
  }
};
export {
  SlackConnector as default
};
