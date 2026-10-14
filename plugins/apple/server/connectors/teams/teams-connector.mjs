import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  IndexedDBFormatError,
  readIndexedDB
} from "../../chunks/chunk-MWIEVOQM.mjs";
import {
  accounts,
  byId
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

// packages/sources/microsoft/teams/dist/teams-source.js
import { setInterval } from "node:timers/promises";

// packages/sdks/microsoft/teams/dist/errors.js
var TeamsUnavailableError = class extends Error {
  name = "TeamsUnavailableError";
  constructor(path, cause) {
    super(`The Microsoft Teams app's store at ${path} cannot be read. Open Teams, sign in and let it load your chats. If macOS denies access, allow the process that runs the export Full Disk Access in System Settings > Privacy & Security.`, { cause });
  }
};
var TeamsFormatError = class extends Error {
  name = "TeamsFormatError";
  constructor(record, problem, cause) {
    super(`The Microsoft Teams app's ${record} has a shape this reader does not read: ${problem}.`, { cause });
  }
};

// packages/sdks/microsoft/teams/dist/teams-store.js
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// packages/sdks/microsoft/teams/dist/fields.js
var Fields = class _Fields {
  #value;
  #record;
  #path;
  constructor(value, record, path) {
    if (!isObject(value))
      throw new TeamsFormatError(record, `${path} is not an object`);
    this.#value = value;
    this.#record = record;
    this.#path = path;
  }
  #fail(name, expected) {
    throw new TeamsFormatError(this.#record, `${this.#path}.${name} is not ${expected}`);
  }
  has(name) {
    return this.#value[name] !== void 0 && this.#value[name] !== null;
  }
  // An absent field and an empty string both mean Teams holds no value.
  string(name) {
    const value = this.#value[name];
    if (value === void 0 || value === null || value === "")
      return null;
    return typeof value === "string" ? value : this.#fail(name, "a string");
  }
  requiredString(name) {
    return this.string(name) ?? this.#fail(name, "a non-empty string");
  }
  // An id Teams writes as a number in some records and as text in others.
  text(name) {
    const value = this.#value[name];
    if (typeof value === "number")
      return String(value);
    return this.string(name);
  }
  requiredText(name) {
    return this.text(name) ?? this.#fail(name, "a non-empty id");
  }
  number(name) {
    const value = this.#value[name];
    if (value === void 0 || value === null)
      return null;
    return typeof value === "number" ? value : this.#fail(name, "a number");
  }
  boolean(name) {
    const value = this.#value[name];
    if (value === void 0 || value === null)
      return null;
    return typeof value === "boolean" ? value : this.#fail(name, "a boolean");
  }
  // A flag Teams keeps as a boolean in some records and as "true" or "false"
  // (any case) in others.
  flag(name) {
    const value = this.#value[name];
    if (typeof value !== "string")
      return this.boolean(name);
    const lower = value.toLowerCase();
    if (lower === "true")
      return true;
    if (lower === "false")
      return false;
    return value === "" ? null : this.#fail(name, "true or false");
  }
  // A count of milliseconds since 1970 as an instant, written as a number or
  // as its digits; 0 means none.
  milliseconds(name) {
    const value = this.#value[name];
    if (value === void 0 || value === null || value === "")
      return null;
    const count = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    if (count === 0)
      return null;
    const date = new Date(typeof count === "number" ? count : Number.NaN);
    return Number.isNaN(date.getTime()) ? this.#fail(name, "a count of milliseconds") : date.toISOString();
  }
  requiredMilliseconds(name) {
    return this.milliseconds(name) ?? this.#fail(name, "a count of milliseconds");
  }
  // An instant Teams writes as ISO 8601 text, in UTC or at an offset, with
  // up to precision fraction digits: the services that write them trim
  // trailing zeros, and some count ten-millionths of a second, which a Date
  // would round. Offsets are whole minutes, so the fraction carries over.
  instant(name, precision) {
    const value = this.string(name);
    if (value === null)
      return null;
    const parts = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(value);
    const fraction = parts?.[2] ?? "";
    const seconds = parts ? Date.parse(`${parts[1]}${parts[3]}`) : Number.NaN;
    if (Number.isNaN(seconds) || fraction.length > precision)
      return this.#fail(name, `an instant to ${precision} fraction digits`);
    const whole = new Date(seconds).toISOString().slice(0, 19);
    return `${whole}.${fraction.padEnd(precision, "0")}Z`;
  }
  requiredInstant(name, precision) {
    return this.instant(name, precision) ?? this.#fail(name, `an instant to ${precision} fraction digits`);
  }
  requiredDate(name) {
    const value = this.#value[name];
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : this.#fail(name, "a date");
  }
  strings(name) {
    const value = this.#value[name];
    if (value === void 0 || value === null)
      return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
      return this.#fail(name, "a list of strings");
    return value;
  }
  object(name) {
    return this.has(name) ? new _Fields(this.#value[name], this.#record, `${this.#path}.${name}`) : null;
  }
  // An object's own entries, each read as Fields: Teams keys a reply chain's
  // messages by sender and client id.
  entries(name) {
    const value = this.#value[name];
    if (value === void 0 || value === null)
      return [];
    if (!isObject(value))
      return this.#fail(name, "an object");
    return Object.entries(value).map(([key2, item]) => [
      key2,
      new _Fields(item, this.#record, `${this.#path}.${name}.${key2}`)
    ]);
  }
  list(name) {
    const value = this.#value[name];
    if (value === void 0 || value === null)
      return [];
    if (!Array.isArray(value))
      return this.#fail(name, "a list");
    return this.#items(name, value);
  }
  // An object Teams keeps either as itself or as its JSON text.
  parsedObject(name) {
    const value = this.#parsed(name);
    return value === null ? null : new _Fields(value, this.#record, `${this.#path}.${name}`);
  }
  // A list Teams keeps either as itself or as its JSON text.
  parsedList(name) {
    const value = this.#parsed(name);
    if (value === null)
      return [];
    if (!Array.isArray(value))
      return this.#fail(name, "a list");
    return this.#items(name, value);
  }
  // A value kept as the JSON Teams holds, for structures this reader passes
  // through whole, such as a message's adaptive cards.
  json(name) {
    const value = this.#parsed(name);
    return value === null || Array.isArray(value) && value.length === 0 || isObject(value) && Object.keys(value).length === 0 ? null : JSON.stringify(value);
  }
  #parsed(name) {
    const value = this.#value[name];
    if (value === void 0 || value === null || value === "")
      return null;
    if (typeof value !== "string")
      return value;
    try {
      return JSON.parse(value);
    } catch (error) {
      const escaped = [...value].map((character) => character < " " ? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}` : character).join("");
      try {
        return JSON.parse(escaped);
      } catch {
        throw new TeamsFormatError(this.#record, `${this.#path}.${name} is not JSON`, error);
      }
    }
  }
  #items(name, items) {
    return items.map((item, index) => new _Fields(item, this.#record, `${this.#path}.${name}[${index}]`));
  }
};
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// packages/sdks/microsoft/teams/dist/conversations.js
var inTeam = /* @__PURE__ */ new Set(["Space", "Topic"]);
function readConversation(conversation2) {
  const id23 = conversation2.requiredString("id");
  const type = conversation2.requiredString("type");
  const thread = conversation2.object("threadProperties");
  const properties22 = conversation2.object("properties");
  return {
    id: id23,
    type,
    topic: thread?.string("topic") ?? null,
    title: conversation2.object("chatTitle")?.string("longTitle") ?? null,
    description: thread?.string("description") ?? null,
    teamId: inTeam.has(type) ? conversation2.string("teamId") : null,
    teamName: thread?.string("spaceThreadTopic") ?? null,
    creatorId: thread?.string("creator") ?? null,
    createdAt: thread?.milliseconds("createdat") ?? null,
    lastMessageAt: conversation2.milliseconds("lastMessageTimeUtc"),
    lastReadAt: lastReadAt(properties22?.string("consumptionhorizon") ?? null),
    isRead: thread?.boolean("isRead") ?? null,
    isFavorite: properties22?.flag("favorite") ?? null,
    isPinned: properties22?.flag("ispinned") ?? null,
    isHidden: thread?.boolean("hidden") ?? null,
    isDeleted: properties22?.boolean("isDeleted") ?? thread?.flag("isdeleted") ?? null,
    visibility: thread?.string("visibility") ?? null,
    subType: thread?.string("threadSubType") ?? null,
    memberCount: conversation2.object("rosterSummary")?.number("memberCount") ?? conversation2.object("chatTitle")?.number("conversationMembersTotalCount") ?? null,
    members: members(conversation2),
    // The thread keeps the pins as JSON text; the conversation's own
    // pinnedItems copy can lag behind it, as it did on 2026-10-12 for a pin
    // just made in the notes chat.
    pinnedMessageIds: (thread?.parsedList("pinnedItems") ?? []).filter((item) => item.string("itemType") === "Message").map((item) => item.requiredString("itemId"))
  };
}
function lastReadAt(horizon) {
  const readAt = Number(horizon?.split(";")[0]);
  return Number.isFinite(readAt) && readAt > 0 ? new Date(readAt).toISOString() : null;
}
function members(conversation2) {
  if (!conversation2.has("members") && !conversation2.has("botMembers"))
    return null;
  const byId2 = /* @__PURE__ */ new Map();
  for (const [list, isBot] of [
    ["members", false],
    ["botMembers", true]
  ])
    for (const member of conversation2.list(list)) {
      const id23 = member.requiredString("id");
      byId2.set(id23, {
        id: id23,
        role: member.string("role"),
        isBot,
        isReader: member.boolean("isReader"),
        shareHistoryAt: member.milliseconds("shareHistoryTime")
      });
    }
  return [...byId2.values()];
}

// packages/sdks/microsoft/teams/dist/feeds.js
function readCallLog(message) {
  const log = message.object("properties")?.parsedObject("call-log");
  if (log === null || log === void 0)
    return null;
  const originator = log.object("originatorParticipant");
  const target = log.object("targetParticipant");
  return {
    id: message.requiredString("id"),
    callId: log.requiredString("callId"),
    startedAt: log.instant("startTime", 7),
    connectedAt: log.instant("connectTime", 7),
    endedAt: log.instant("endTime", 7),
    direction: log.string("callDirection"),
    callType: log.string("callType"),
    state: log.string("callState"),
    originatorId: originator?.string("id") ?? log.string("originator"),
    originatorName: originator?.string("displayName") ?? null,
    targetId: target?.string("id") ?? log.string("target"),
    targetType: target?.string("type") ?? null,
    conversationId: log.string("threadId"),
    messageId: log.string("messageId"),
    forwardedTo: log.object("forwardingInfo")?.string("forwardingDestinationType") ?? null,
    participants: log.list("participantList").map((participant) => ({
      id: participant.requiredString("id"),
      type: participant.string("type"),
      tenantId: participant.string("tenantId")
    }))
  };
}
function readActivity(message, feed, read) {
  const activity = message.object("properties")?.object("activity");
  if (activity === null || activity === void 0)
    return null;
  const id23 = message.requiredString("id");
  return {
    feed,
    id: id23,
    activityId: activity.text("activityId"),
    type: activity.requiredString("activityType"),
    subtype: activity.string("activitySubtype"),
    occurredAt: activity.instant("activityTimestamp", 3) ?? message.requiredMilliseconds("originalArrivalTime"),
    sourceConversationId: activity.string("sourceThreadId"),
    sourceThreadId: activity.text("sourceReplyChainId"),
    sourceMessageId: activity.text("sourceMessageId"),
    sourceUserId: activity.string("sourceUserId"),
    sourceUserName: activity.string("sourceUserImDisplayName"),
    sourceTopic: activity.string("sourceThreadTopic"),
    preview: activity.string("messagePreview"),
    isRead: read.get(id23) ?? null
  };
}
function readSaved(message, feed) {
  const properties22 = message.object("properties");
  const id23 = message.requiredString("id");
  const activity = properties22?.object("activity");
  if (activity !== null && activity !== void 0)
    return {
      feed,
      id: id23,
      conversationId: activity.string("sourceThreadId"),
      threadId: activity.text("sourceReplyChainId"),
      messageId: activity.text("sourceMessageId"),
      savedAt: activity.instant("activityTimestamp", 3) ?? message.requiredMilliseconds("originalArrivalTime")
    };
  const starred = properties22?.object("starred");
  if (starred === null || starred === void 0)
    return null;
  return {
    feed,
    id: id23,
    conversationId: starred.string("threadId"),
    threadId: starred.string("parentMessageId"),
    messageId: starred.string("messageId"),
    savedAt: message.requiredMilliseconds("originalArrivalTime")
  };
}

// packages/sdks/microsoft/teams/dist/folders.js
function readFolder(folder) {
  return {
    id: folder.requiredString("id"),
    name: folder.string("name"),
    folderType: folder.string("folderType"),
    sortType: folder.string("sortType"),
    emoji: folder.string("emojiCode"),
    isHidden: folder.boolean("isHidden"),
    isDeleted: folder.boolean("isDeleted"),
    createdAt: folder.milliseconds("createdTime"),
    conversations: folder.list("conversations").map((conversation2) => ({
      conversationId: conversation2.requiredString("id"),
      addedAt: conversation2.milliseconds("createdTime")
    }))
  };
}

// packages/sdks/microsoft/teams/dist/installed-apps.js
var scopes = /* @__PURE__ */ new Map([
  ["Personal", "user"],
  ["GroupChat", "chat"],
  ["Team", "team"]
]);
function readAppScope(entitlements) {
  const scope = scopes.get(entitlements.requiredString("cacheKey").split("_")[0] ?? "");
  const scopeId = entitlements.requiredString("appEntitlementkey");
  return scope === void 0 || scopeId === "default" ? null : { scope, scopeId };
}
function readInstalledApps(entitlements, { scope, scopeId }, names) {
  return entitlements.list("appEntitlements").filter((app) => app.requiredString("state").startsWith("Installed")).map((app) => {
    const appId = app.requiredString("id");
    const definition = names.get(appId);
    return {
      scope,
      scopeId,
      appId,
      state: app.requiredString("state"),
      version: app.string("installedVersion"),
      installedBy: app.string("installedBy"),
      name: definition?.string("name") ?? null,
      developerName: definition?.string("developerName") ?? null
    };
  });
}

// packages/sdks/microsoft/teams/dist/meetings.js
function readMeeting(event) {
  return {
    id: event.requiredString("objectId"),
    iCalUid: event.string("iCalUID"),
    seriesMasterId: event.string("seriesMasterId"),
    eventType: event.string("eventType"),
    subject: event.string("subject"),
    startAt: event.requiredDate("startTime"),
    endAt: event.requiredDate("endTime"),
    timeZone: event.string("eventTimeZone"),
    location: event.string("location"),
    organizerName: event.string("organizerName"),
    organizerAddress: event.string("organizerAddress"),
    isOnlineMeeting: event.boolean("isOnlineMeeting"),
    joinUrl: event.string("skypeTeamsMeetingUrl"),
    // The meeting's chat (TeamsConversation.id).
    conversationId: event.object("skypeTeamsDataObject")?.string("cid") ?? null,
    myResponse: event.string("myResponseType"),
    showAs: event.string("showAs"),
    isCancelled: event.boolean("isCancelled") ?? false,
    bodyPreview: event.string("bodyPreview"),
    modifiedAt: event.instant("lastModifiedTime", 7),
    attendees: event.list("attendees").map((attendee) => ({
      address: attendee.requiredString("address"),
      name: attendee.string("name"),
      type: attendee.string("type"),
      role: attendee.string("role"),
      response: attendee.object("status")?.string("response") ?? null
    }))
  };
}

// packages/sdks/microsoft/teams/dist/messages.js
function readMessage(message) {
  return {
    conversationId: message.requiredString("conversationId"),
    threadId: message.requiredString("parentMessageId"),
    id: message.requiredString("id"),
    sentAt: message.requiredMilliseconds("originalArrivalTime"),
    senderId: message.string("creator"),
    senderName: message.string("imDisplayName"),
    messageType: message.requiredString("messageType"),
    contentType: message.string("contentType"),
    isFromUser: message.boolean("isSentByCurrentUser"),
    ...body(message)
  };
}
function readLastMessage(message, conversationId6) {
  const id23 = message.requiredString("id");
  const link2 = message.string("conversationLink");
  return {
    conversationId: conversationId6,
    threadId: (link2 && /;messageid=(\d+)$/.exec(link2)?.[1]) ?? id23,
    id: id23,
    sentAt: message.requiredInstant("originalarrivaltime", 3),
    senderId: message.string("fromUserId"),
    senderName: message.string("imdisplayname"),
    messageType: message.requiredString("messagetype"),
    contentType: message.string("contenttype"),
    isFromUser: null,
    ...body(message)
  };
}
function body(message) {
  const properties22 = message.object("properties");
  const pinned = properties22?.parsedObject("pinned");
  const pinnedAt = pinned?.milliseconds("pinnedTime") ?? null;
  return {
    content: message.string("content"),
    subject: properties22?.string("subject") ?? null,
    importance: properties22?.string("importance") ?? null,
    editedAt: properties22?.milliseconds("edittime") ?? null,
    deletedAt: properties22?.milliseconds("deletetime") ?? properties22?.milliseconds("hardDeleteTime") ?? null,
    cardsJson: properties22?.json("cards") ?? null,
    reactions: properties22?.list("emotions").flatMap(reactions) ?? [],
    mentions: properties22?.parsedList("mentions").map(mention) ?? [],
    files: properties22?.parsedList("files").map(file) ?? [],
    links: properties22?.parsedList("links").map(link) ?? [],
    quotes: properties22?.list("qtdMsgs").map(quote) ?? [],
    pinnedBy: pinnedAt === null ? null : pinned?.string("creatorId") ?? null,
    pinnedAt
  };
}
function reactions(emotion) {
  const emoji = emotion.requiredString("key");
  return emotion.list("users").map((user) => ({
    emoji,
    userId: user.requiredString("mri"),
    reactedAt: user.milliseconds("time")
  }));
}
function mention(mention2, index) {
  return {
    position: mention2.number("itemid") ?? index,
    mentionedId: mention2.requiredString("mri"),
    kind: mention2.string("mentionType"),
    displayName: mention2.string("displayName")
  };
}
function file(file2) {
  const info = file2.object("fileInfo");
  return {
    id: file2.string("itemid") ?? file2.requiredString("id"),
    name: file2.string("fileName"),
    fileType: file2.string("fileType"),
    title: file2.string("title"),
    url: info?.string("fileUrl") ?? file2.string("objectUrl"),
    siteUrl: info?.string("siteUrl") ?? null,
    shareUrl: info?.string("shareUrl") ?? null,
    service: file2.object("fileChicletState")?.string("serviceName") ?? null
  };
}
function link(link2, position5) {
  const preview = link2.object("preview");
  return {
    position: position5,
    url: link2.requiredString("url"),
    title: preview?.string("title") ?? null,
    description: preview?.string("description") ?? null,
    previewUrl: preview?.string("previewurl") ?? null
  };
}
function quote(quote2) {
  return {
    messageId: quote2.requiredText("messageId"),
    senderId: quote2.string("sender"),
    sentAt: quote2.milliseconds("time"),
    threadId: quote2.string("replyChainId")
  };
}

// packages/sdks/microsoft/teams/dist/people.js
function readPerson(profile2) {
  return {
    mri: profile2.requiredString("mri"),
    objectId: profile2.string("objectId"),
    type: profile2.string("type"),
    displayName: profile2.string("displayName"),
    givenName: profile2.string("givenName"),
    surname: profile2.string("surname"),
    email: profile2.string("email") ?? profile2.string("mail"),
    userPrincipalName: profile2.string("userPrincipalName"),
    jobTitle: profile2.string("jobTitle"),
    department: profile2.string("department"),
    companyName: profile2.string("companyName"),
    officeLocation: profile2.string("physicalDeliveryOfficeName"),
    userLocation: profile2.string("userLocation"),
    tenantName: profile2.string("tenantName"),
    userType: profile2.string("userType")
  };
}

// packages/sdks/microsoft/teams/dist/sync-windows.js
var SyncWindows = class {
  #windows;
  constructor(states) {
    const windows = /* @__PURE__ */ new Map();
    for (const state of states) {
      const id23 = state.string("id");
      const start = state.number("chatServiceStartOfSyncWindow");
      const end = state.number("chatServiceEndOfSyncWindow");
      if (id23 === null || start === null || end === null || state.boolean("isGapDetected") === true)
        continue;
      windows.set(id23, {
        start,
        end,
        toStartOfTime: state.boolean("_isSyncedToStartOfTime") === true
      });
    }
    this.#windows = windows;
  }
  // A thread's first message, and every chat message, lies in its
  // conversation's span. A channel loads only the latest replies of each
  // thread with its posts, so a reply lies only in its thread's own span.
  holds(conversationId6, threadId, messageId) {
    const time = Number(messageId);
    if (!Number.isFinite(time))
      return false;
    const window = threadId === messageId ? this.#windows.get(conversationId6) : this.#windows.get(`${conversationId6};messageid=${threadId}`);
    return window !== void 0 && time <= window.end && (window.toStartOfTime || time >= window.start);
  }
};

// packages/sdks/microsoft/teams/dist/teams-client-reader.js
var feeds = /* @__PURE__ */ new Set([
  "48:calllogs",
  "48:notifications",
  "48:annotations",
  "48:saved",
  "48:starred",
  "48:threads",
  "48:mentions"
]);
function readTeamsClient(account2, databases) {
  const records = (manager, store) => stored(databases.get(manager), store);
  const windows = new SyncWindows(records("syncstate-manager", "syncstates"));
  const read = new Map(records("activity-manager", "feed-items").map((item) => [
    item.requiredString("messageId"),
    item.boolean("isRead")
  ]));
  const messages = /* @__PURE__ */ new Map();
  const callLogs = [];
  const activities = [];
  const savedMessages = [];
  const chains = [
    ...records("replychain-manager", "replychains"),
    ...records("streams-replychain-manager", "saved")
  ];
  for (const chain of chains) {
    for (const [, fields] of chain.entries("messageMap")) {
      const conversationId6 = fields.requiredString("conversationId");
      const feed = conversationId6.slice("48:".length);
      let described = false;
      if (conversationId6 === "48:calllogs") {
        described = push(callLogs, readCallLog(fields));
      } else if (conversationId6 === "48:notifications" || conversationId6 === "48:annotations") {
        described = push(activities, readActivity(fields, feed, read));
      } else if (conversationId6 === "48:saved" || conversationId6 === "48:starred") {
        described = push(savedMessages, readSaved(fields, feed));
      }
      if (described)
        continue;
      const message = readMessage(fields);
      messages.set(key(message), message);
    }
  }
  const conversations = records("conversation-manager", "conversations");
  for (const conversation2 of conversations) {
    const id23 = conversation2.requiredString("id");
    if (feeds.has(id23))
      continue;
    for (const name of ["lastMessage", "lastNonTMMessage"]) {
      const last = conversation2.object(name);
      if (last === null || !last.has("messagetype"))
        continue;
      const message = readLastMessage(last, id23);
      if (!messages.has(key(message)))
        messages.set(key(message), message);
    }
  }
  const definitions = new Map([
    ...records("user-installed-apps-manager", "user-app-definitions"),
    ...records("chat-installed-apps-manager", "app-definitions"),
    ...records("team-installed-apps-manager", "app-definitions")
  ].flatMap((definition) => {
    const item = definition.object("item");
    return item === null ? [] : [[definition.requiredString("appId"), item]];
  }));
  const entitlements = [
    ...records("user-installed-apps-manager", "user-app-entitlements"),
    ...records("chat-installed-apps-manager", "app-entitlements"),
    ...records("team-installed-apps-manager", "app-entitlements")
  ].flatMap((fields) => {
    const scope = readAppScope(fields);
    return scope === null ? [] : [{ fields, scope }];
  });
  const appScopes = new Set(entitlements.map(({ scope }) => `${scope.scope}
${scope.scopeId}`));
  return {
    account: account2,
    conversations: conversations.map(readConversation),
    messages: [...messages.values()],
    callLogs,
    activities,
    people: records("profiles", "profiles").map(readPerson),
    meetings: records("calendar", "calendar").map(readMeeting),
    folders: records("conversation-folder-manager", "folders").map(readFolder),
    savedMessages,
    installedApps: entitlements.flatMap(({ fields, scope }) => readInstalledApps(fields, scope, definitions)),
    searches: records("search-history-manager", "searchhistory").filter((entry) => entry.string("entityType") === "SEARCH").flatMap((entry) => {
      const query = entry.object("autoSuggestEntity")?.string("searchQuery");
      return query === null || query === void 0 ? [] : [
        {
          id: entry.requiredString("uniqueId"),
          query,
          searchedAt: entry.milliseconds("lastClickedTime")
        }
      ];
    }),
    holds: (conversationId6, threadId, messageId) => windows.holds(conversationId6, threadId, messageId),
    holdsApps: (scope, scopeId) => appScopes.has(`${scope}
${scopeId}`)
  };
}
function stored(database, name) {
  const store = database?.objectStores.find((store2) => store2.name === name);
  return (store?.records ?? []).map(({ key: key2, value }) => new Fields(value, `${database?.name}/${name}`, JSON.stringify(key2)));
}
function push(list, item) {
  if (item === null)
    return false;
  list.push(item);
  return true;
}
function key({ conversationId: conversationId6, id: id23 }) {
  return `${conversationId6}
${id23}`;
}

// packages/sdks/microsoft/teams/dist/teams-store.js
var profile = "Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams/EBWebView/WV2Profile_tfw";
var indexedDB = "IndexedDB/https_teams.microsoft.com_0.indexeddb.leveldb";
var databaseName = /^Teams:([^:]+):react-web-client:(.+):([^:]+)$/;
var objectId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
var attempts = 3;
var unreadable = /* @__PURE__ */ new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"]);
function teamsDirectory() {
  return join(homedir(), profile);
}
var TeamsStore = class {
  #directory;
  constructor(directory = teamsDirectory()) {
    this.#directory = directory;
  }
  // Every account signed in to the app, as its web client last saved it.
  async clients() {
    const databases = await this.#read();
    return accounts2(databases).map(({ account: account2, managers }) => readTeamsClient(account2, managers));
  }
  // A value that changes whenever the web client writes its caches.
  version() {
    const directory = join(this.#directory, indexedDB);
    try {
      return readdirSync(directory).sort().map((name) => {
        const stats = statSync(join(directory, name), {
          throwIfNoEntry: false
        });
        return `${name}:${stats?.size}:${stats?.mtimeMs}`;
      }).join("\n");
    } catch (error) {
      throw new TeamsUnavailableError(this.#directory, error);
    }
  }
  async #read() {
    for (let attempt = 1; ; attempt++) {
      try {
        return await readIndexedDB(join(this.#directory, indexedDB));
      } catch (error) {
        if (error instanceof IndexedDBFormatError)
          throw new TeamsFormatError("IndexedDB", error.message, error);
        const code = errorCode(error);
        if (code === "ENOENT" && attempt < attempts && this.#exists())
          continue;
        if (typeof code === "string" && unreadable.has(code))
          throw new TeamsUnavailableError(this.#directory, error);
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
function accounts2(databases) {
  const named = databases.flatMap((database) => {
    const parts = databaseName.exec(database.name);
    if (parts === null)
      return [];
    const [, manager = "", ids = "", locale = ""] = parts;
    return [
      {
        database,
        manager,
        locale,
        ids: [...ids.matchAll(objectId)].map(String)
      }
    ];
  });
  const live = /* @__PURE__ */ new Map();
  for (const { database, manager, locale, ids } of named) {
    if (manager !== "conversation-manager")
      continue;
    const [tenantId, userId] = ids;
    if (tenantId === void 0 || userId === void 0)
      throw new TeamsFormatError(database.name, "it names no tenant and user");
    const managers = new Map(named.filter((other2) => other2.locale === locale && other2.ids.length === 2 && other2.ids.includes(tenantId) && other2.ids.includes(userId)).map(({ manager: manager2, database: database2 }) => [manager2, database2]));
    const other = live.get(`${tenantId}:${userId}`);
    if (other !== void 0 && lastSynced(other.managers) >= lastSynced(managers))
      continue;
    live.set(`${tenantId}:${userId}`, {
      account: {
        userId,
        tenantId,
        mri: `8:orgid:${userId}`,
        tenantDomains: tenantDomains(managers.get("tenant-manager"))
      },
      managers
    });
  }
  return [...live.values()];
}
function lastSynced(managers) {
  const database = managers.get("syncstate-manager");
  const states = database?.objectStores.find(({ name }) => name === "syncstates");
  return Math.max(Number.NEGATIVE_INFINITY, ...(states?.records ?? []).map(({ key: key2, value }) => new Fields(value, `${database?.name}/syncstates`, JSON.stringify(key2)).number("lastSyncTime") ?? Number.NEGATIVE_INFINITY));
}
function tenantDomains(database) {
  const record = database?.objectStores.find(({ name }) => name === "tenant")?.records.find(({ key: key2 }) => key2 === "domains");
  return record === void 0 ? [] : new Fields(record.value, `${database?.name}/tenant`, "domains").strings("value");
}
function errorCode(error) {
  return error instanceof Error && "code" in error ? error.code : void 0;
}

// packages/sources/microsoft/teams/dist/teams-stream.js
var teamsFields = {
  id: { type: "string", minLength: 1 },
  position: { type: "integer", minimum: 0 },
  nullableText: { type: ["string", "null"] },
  nullableBoolean: { type: ["boolean", "null"] },
  nullableInteger: { type: ["integer", "null"] },
  textList: { type: "array", items: { type: "string" } },
  accountId: {
    type: "string",
    minLength: 1,
    description: "The account (accounts.id)."
  },
  conversationId: {
    type: "string",
    minLength: 1,
    description: "The conversation (conversations.id)."
  },
  instant: { type: "string", format: "date-time" },
  nullableInstant: { type: ["string", "null"], format: "date-time" },
  // The calling service's times, to the ten-millionth of a second.
  nullablePreciseInstant: {
    type: ["string", "null"],
    format: "date-time",
    precision: 7
  }
};
var TeamsStream = class {
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
    return validateRecords(this, this.rows(scan).flatMap((row) => this.records(row)), "Microsoft Teams");
  }
  // Whether the scan vouches for a row it no longer holds, so that it was
  // deleted: every row of an account the app still keeps.
  covers(scan, key2) {
    return scan.keeps(key2.accountId);
  }
};

// packages/sources/microsoft/teams/dist/streams/accounts-stream.js
var { id, textList } = teamsFields;
var properties = {
  id: {
    ...id,
    description: "The user\u2019s Microsoft Entra object ID: the account signed in to Teams on this Mac."
  },
  tenantId: {
    ...id,
    description: "The Microsoft Entra ID of the organization signed in to."
  },
  mri: {
    ...id,
    description: "The user\u2019s Teams ID, 8:orgid:<id>, as messages and members name people (people.mri)."
  },
  tenantDomains: {
    ...textList,
    description: "The organization\u2019s verified domains."
  }
};
var AccountsStream = class extends TeamsStream {
  name = "accounts";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One record per work or school account signed in to the Teams app on this Mac. Primary key id. An account the app no longer keeps, such as one signed out of, stays.",
    properties,
    required: Object.keys(properties)
  };
  covers(scan, key2) {
    return scan.keeps(key2.id);
  }
  rows(scan) {
    return scan.clients;
  }
  records({ account: account2 }) {
    return [
      {
        id: account2.userId,
        tenantId: account2.tenantId,
        mri: account2.mri,
        tenantDomains: [...account2.tenantDomains]
      }
    ];
  }
};

// packages/sources/microsoft/teams/dist/streams/activities-stream.js
var { id: id2, accountId, instant, nullableText, nullableBoolean } = teamsFields;
var properties2 = {
  accountId,
  feed: {
    ...id2,
    description: "notifications for the activity feed, annotations for reactions to the user\u2019s messages."
  },
  id: {
    ...id2,
    description: "The entry\u2019s ID in its feed, when it arrived in milliseconds since 1970."
  },
  activityId: {
    ...nullableText,
    description: "The activity service\u2019s ID for it."
  },
  type: {
    ...id2,
    description: "What happened, such as mention, mentionInChat, reactionInChat, call, or msGraph for an app\u2019s notice."
  },
  subtype: { ...nullableText, description: "Teams\u2019 finer kind of it." },
  occurredAt: { ...instant, description: "When it happened." },
  sourceConversationId: {
    ...nullableText,
    description: "The conversation it happened in (conversations.id)."
  },
  sourceThreadId: {
    ...nullableText,
    description: "The thread there (messages.threadId)."
  },
  sourceMessageId: {
    ...nullableText,
    description: "The message it is about (messages.id)."
  },
  sourceUserId: {
    ...nullableText,
    description: "Who did it (people.mri)."
  },
  sourceUserName: { ...nullableText, description: "Their name." },
  sourceTopic: {
    ...nullableText,
    description: "The name of the conversation it happened in."
  },
  preview: {
    ...nullableText,
    description: "The text the feed shows for it."
  },
  isRead: {
    ...nullableBoolean,
    description: "Whether the user has opened it in the activity feed."
  }
};
var ActivitiesStream = class extends TeamsStream {
  name = "activities";
  primaryKey = ["accountId", "feed", "id"];
  jsonSchema = {
    type: "object",
    description: "One record per entry of the account\u2019s activity feed, and of the reactions to the user\u2019s messages, that the app holds. Primary key accountId, feed, id. An entry removed from the part of a feed the app still holds is deleted; one the app dropped from its cache stays.",
    properties: properties2,
    required: Object.keys(properties2)
  };
  covers(scan, key2) {
    return scan.holds(key2.accountId, `48:${String(key2.feed)}`, key2.id, key2.id);
  }
  rows(scan) {
    return scan.clients.flatMap(({ account: account2, activities }) => activities.map((activity) => ({ accountId: account2.userId, activity })));
  }
  records({ accountId: accountId17, activity }) {
    return [{ accountId: accountId17, ...activity }];
  }
};

// packages/sources/microsoft/teams/dist/streams/call-logs-stream.js
var { id: id3, accountId: accountId2, nullableText: nullableText2, nullablePreciseInstant } = teamsFields;
var properties3 = {
  accountId: accountId2,
  id: {
    ...id3,
    description: "The entry\u2019s ID in Teams\u2019 call history, when it was logged in milliseconds since 1970."
  },
  callId: { ...id3, description: "The calling service\u2019s ID for the call." },
  startedAt: { ...nullablePreciseInstant, description: "When it rang." },
  connectedAt: {
    ...nullablePreciseInstant,
    description: "When it was answered; NULL if it never was."
  },
  endedAt: { ...nullablePreciseInstant, description: "When it ended." },
  direction: { ...nullableText2, description: "incoming or outgoing." },
  callType: {
    ...nullableText2,
    description: "twoParty for a call between two, multiParty for a meeting."
  },
  state: { ...nullableText2, description: "accepted, declined or missed." },
  originatorId: {
    ...nullableText2,
    description: "Who placed it (people.mri)."
  },
  originatorName: {
    ...nullableText2,
    description: "The caller\u2019s name as logged."
  },
  targetId: { ...nullableText2, description: "Who was called (people.mri)." },
  targetType: {
    ...nullableText2,
    description: "default, or voicemail when the call went there."
  },
  conversationId: {
    ...nullableText2,
    description: "The meeting chat it took place in (conversations.id)."
  },
  messageId: {
    ...nullableText2,
    description: "Its message in that chat (messages.id)."
  },
  forwardedTo: {
    ...nullableText2,
    description: "Where it was forwarded unanswered, such as voicemail."
  }
};
var CallLogsStream = class extends TeamsStream {
  name = "callLogs";
  primaryKey = ["accountId", "id"];
  jsonSchema = {
    type: "object",
    description: "One record per call in the account\u2019s Teams call history that the app holds. Primary key accountId, id. An entry removed from the part of the history the app still holds is deleted; one the app dropped from its cache stays.",
    properties: properties3,
    required: Object.keys(properties3)
  };
  covers(scan, key2) {
    return scan.holds(key2.accountId, "48:calllogs", key2.id, key2.id);
  }
  rows(scan) {
    return scan.clients.flatMap(({ account: account2, callLogs }) => callLogs.map((log) => ({ accountId: account2.userId, log })));
  }
  records({ accountId: accountId17, log: { participants: _participants, ...log } }) {
    return [{ accountId: accountId17, ...log }];
  }
};

// packages/sources/microsoft/teams/dist/streams/call-participants-stream.js
var { id: id4, accountId: accountId3, nullableText: nullableText3 } = teamsFields;
var properties4 = {
  accountId: accountId3,
  callLogId: { ...id4, description: "The call (callLogs.id)." },
  participantId: {
    ...id4,
    description: "Who took part (people.mri), or a service such as call park."
  },
  type: { ...nullableText3, description: "default, or the service\u2019s kind." },
  tenantId: {
    ...nullableText3,
    description: "The participant\u2019s organization (accounts.tenantId)."
  }
};
var CallParticipantsStream = class extends TeamsStream {
  name = "callParticipants";
  primaryKey = ["accountId", "callLogId", "participantId"];
  jsonSchema = {
    type: "object",
    description: "One record per participant Teams logged for a group call; a call between two has its people in callLogs. Primary key accountId, callLogId, participantId. Kept and deleted with its call.",
    properties: properties4,
    required: Object.keys(properties4)
  };
  covers(scan, key2) {
    return scan.holds(key2.accountId, "48:calllogs", key2.callLogId, key2.callLogId);
  }
  rows(scan) {
    return scan.clients.flatMap(({ account: account2, callLogs }) => callLogs.flatMap(({ id: id23, participants }) => participants.map(({ id: participantId, ...participant }) => ({
      accountId: account2.userId,
      callLogId: id23,
      participantId,
      ...participant
    }))));
  }
  records(row) {
    return [row];
  }
};

// packages/sources/microsoft/teams/dist/streams/conversation-members-stream.js
var { id: id5, accountId: accountId4, conversationId, nullableText: nullableText4, nullableBoolean: nullableBoolean2, nullableInstant } = teamsFields;
var properties5 = {
  accountId: accountId4,
  conversationId,
  memberId: {
    ...id5,
    description: "The member\u2019s Teams ID: 8:orgid:<id> for a person (people.mri), 28:<id> for a bot."
  },
  role: { ...nullableText4, description: "Admin or User." },
  isBot: { type: "boolean", description: "Whether the member is a bot." },
  isReader: {
    ...nullableBoolean2,
    description: "Whether the member can only read."
  },
  shareHistoryAt: {
    ...nullableInstant,
    description: "From when the member sees the conversation\u2019s history, for one added later."
  }
};
var ConversationMembersStream = class extends TeamsStream {
  name = "conversationMembers";
  primaryKey = ["accountId", "conversationId", "memberId"];
  jsonSchema = {
    type: "object",
    description: "One record per member of a chat, meeting chat or team, as Teams keeps them; a channel\u2019s members are its team\u2019s. Primary key accountId, conversationId, memberId. A member who left is deleted.",
    properties: properties5,
    required: Object.keys(properties5)
  };
  covers(scan, key2) {
    return scan.holdsMembers(key2.accountId, key2.conversationId);
  }
  rows(scan) {
    return scan.clients.flatMap(({ account: account2, conversations }) => conversations.filter(({ id: id23 }) => scan.conversationSelected(id23)).flatMap(({ id: id23, members: members2 }) => (members2 ?? []).map((member) => ({
      accountId: account2.userId,
      conversationId: id23,
      member
    }))));
  }
  records({ member: { id: id23, ...member }, ...row }) {
    return [{ ...row, memberId: id23, ...member }];
  }
};

// packages/sources/microsoft/teams/dist/streams/conversations-stream.js
var { id: id6, accountId: accountId5, nullableText: nullableText5, nullableBoolean: nullableBoolean3, nullableInteger, nullableInstant: nullableInstant2 } = teamsFields;
var properties6 = {
  accountId: accountId5,
  id: {
    ...id6,
    description: "Teams\u2019 ID for the conversation, such as 19:\u2026@thread.v2 for a chat, 19:\u2026@thread.tacv2 for a channel, or 48:notes for the user\u2019s own notes."
  },
  type: {
    ...id6,
    description: "Teams\u2019 kind of conversation: Chat, Meeting (a meeting\u2019s chat), Space (a team\u2019s own conversation, its General channel), Topic (a channel), StreamOfNotes (the user\u2019s notes), EngageCommunity, or Conversation and Thread, which Teams keeps for its own lists."
  },
  topic: {
    ...nullableText5,
    description: "The name its members gave it: a chat\u2019s or meeting\u2019s topic, a channel\u2019s name; NULL for a chat never named."
  },
  title: {
    ...nullableText5,
    description: "The title Teams shows for a chat, from its members\u2019 names when it has no topic."
  },
  description: { ...nullableText5, description: "A channel\u2019s description." },
  teamId: {
    ...nullableText5,
    description: "For a team or a channel, the team (conversations.id of the team\u2019s Space)."
  },
  teamName: { ...nullableText5, description: "For a team, its name." },
  creatorId: {
    ...nullableText5,
    description: "Who created it (people.mri)."
  },
  createdAt: { ...nullableInstant2, description: "When it was created." },
  lastMessageAt: {
    ...nullableInstant2,
    description: "When its newest message arrived."
  },
  lastReadAt: {
    ...nullableInstant2,
    description: "When the user last read it; NULL if never."
  },
  isRead: {
    ...nullableBoolean3,
    description: "Whether the user has read its newest message."
  },
  isFavorite: {
    ...nullableBoolean3,
    description: "Whether the user marked the channel a favorite."
  },
  isPinned: {
    ...nullableBoolean3,
    description: "Whether the user pinned it to the top of the chat list."
  },
  isHidden: {
    ...nullableBoolean3,
    description: "Whether the user hid it from the chat list."
  },
  isDeleted: {
    ...nullableBoolean3,
    description: "Whether it was deleted, as a deleted channel is."
  },
  visibility: {
    ...nullableText5,
    description: "For a team, public or private."
  },
  subType: {
    ...nullableText5,
    description: "For a channel, its kind, such as PrivateChannel."
  },
  memberCount: {
    ...nullableInteger,
    description: "How many members it has, as Teams last counted."
  }
};
var ConversationsStream = class extends TeamsStream {
  name = "conversations";
  primaryKey = ["accountId", "id"];
  jsonSchema = {
    type: "object",
    description: "One record per chat, meeting chat, team and channel of the account, all of them, as Teams syncs the whole list. Primary key accountId, id. A conversation the account left or that was deleted is deleted.",
    properties: properties6,
    required: Object.keys(properties6)
  };
  rows(scan) {
    return scan.clients.flatMap(({ account: account2, conversations }) => conversations.filter(({ id: id23 }) => scan.conversationSelected(id23)).map((conversation2) => ({ accountId: account2.userId, conversation: conversation2 })));
  }
  records({ accountId: accountId17, conversation: { members: _members, pinnedMessageIds: _pins, ...conversation2 } }) {
    return [{ accountId: accountId17, ...conversation2 }];
  }
};

// packages/sources/microsoft/teams/dist/streams/folder-conversations-stream.js
var { id: id7, accountId: accountId6, conversationId: conversationId2, nullableInstant: nullableInstant3 } = teamsFields;
var properties7 = {
  accountId: accountId6,
  folderId: { ...id7, description: "The folder (folders.id)." },
  conversationId: conversationId2,
  addedAt: {
    ...nullableInstant3,
    description: "When the conversation was put in the folder."
  }
};
var FolderConversationsStream = class extends TeamsStream {
  name = "folderConversations";
  primaryKey = ["accountId", "folderId", "conversationId"];
  jsonSchema = {
    type: "object",
    description: "One record per conversation in a folder of the chat list. Primary key accountId, folderId, conversationId. A conversation taken out of a folder is deleted.",
    properties: properties7,
    required: Object.keys(properties7)
  };
  rows(scan) {
    return scan.clients.flatMap(({ account: account2, folders }) => folders.flatMap(({ id: id23, conversations }) => conversations.filter(({ conversationId: conversationId6 }) => scan.conversationSelected(conversationId6)).map((conversation2) => ({
      accountId: account2.userId,
      folderId: id23,
      ...conversation2
    }))));
  }
  records(row) {
    return [row];
  }
};

// packages/sources/microsoft/teams/dist/streams/folders-stream.js
var { id: id8, accountId: accountId7, nullableText: nullableText6, nullableBoolean: nullableBoolean4, nullableInstant: nullableInstant4 } = teamsFields;
var properties8 = {
  accountId: accountId7,
  id: { ...id8, description: "Teams\u2019 ID for the folder." },
  name: { ...nullableText6, description: "Its name." },
  folderType: {
    ...nullableText6,
    description: "UserCreated for the user\u2019s own, or the kind Teams keeps, such as Favorites, Chats, TeamsAndChannels or EngageCommunities."
  },
  sortType: {
    ...nullableText6,
    description: "How it orders its conversations, such as MostRecent."
  },
  emoji: { ...nullableText6, description: "The emoji the user gave it." },
  isHidden: { ...nullableBoolean4, description: "Whether it is hidden." },
  isDeleted: { ...nullableBoolean4, description: "Whether it was deleted." },
  createdAt: { ...nullableInstant4, description: "When it was created." }
};
var FoldersStream = class extends TeamsStream {
  name = "folders";
  primaryKey = ["accountId", "id"];
  jsonSchema = {
    type: "object",
    description: "One record per folder of the account\u2019s chat list. Primary key accountId, id. A folder Teams no longer lists is deleted.",
    properties: properties8,
    required: Object.keys(properties8)
  };
  rows(scan) {
    return scan.clients.flatMap(({ account: account2, folders }) => folders.map((folder) => ({ accountId: account2.userId, folder })));
  }
  records({ accountId: accountId17, folder: { conversations: _conversations, ...folder } }) {
    return [{ accountId: accountId17, ...folder }];
  }
};

// packages/sources/microsoft/teams/dist/streams/installed-apps-stream.js
var { id: id9, accountId: accountId8, nullableText: nullableText7 } = teamsFields;
var properties9 = {
  accountId: accountId8,
  scope: {
    ...id9,
    description: "Where it is installed: user, chat or team."
  },
  scopeId: {
    ...id9,
    description: "The user (accounts.id), or the chat or team (conversations.id)."
  },
  appId: { ...id9, description: "The app\u2019s ID in the Teams app store." },
  state: {
    ...id9,
    description: "Installed, InstalledAndPermanent (installed by the organization), InstalledAndDeprecated or InstalledAndHidden."
  },
  version: { ...nullableText7, description: "The version installed." },
  installedBy: {
    ...nullableText7,
    description: "Who installed it (people.mri)."
  },
  name: { ...nullableText7, description: "The app\u2019s name." },
  developerName: { ...nullableText7, description: "Who makes it." }
};
var InstalledAppsStream = class extends TeamsStream {
  name = "installedApps";
  primaryKey = ["accountId", "scope", "scopeId", "appId"];
  jsonSchema = {
    type: "object",
    description: "One record per app installed for the user, or in a chat or team whose apps the app has loaded. Primary key accountId, scope, scopeId, appId. An app uninstalled where the app still holds the list is deleted.",
    properties: properties9,
    required: Object.keys(properties9)
  };
  covers(scan, key2) {
    return scan.holdsApps(key2.accountId, key2.scope, key2.scopeId);
  }
  rows(scan) {
    return scan.clients.flatMap(({ account: account2, installedApps }) => installedApps.map((app) => ({ accountId: account2.userId, ...app })));
  }
  records(row) {
    return [row];
  }
};

// packages/sources/microsoft/teams/dist/streams/meeting-attendees-stream.js
var { id: id10, accountId: accountId9, nullableText: nullableText8 } = teamsFields;
var properties10 = {
  accountId: accountId9,
  meetingId: { ...id10, description: "The meeting (meetings.id)." },
  address: { ...id10, description: "The attendee\u2019s email address." },
  name: { ...nullableText8, description: "Their name." },
  type: {
    ...nullableText8,
    description: "Required, Optional, Organizer or Resource."
  },
  role: { ...nullableText8, description: "Their role, such as User." },
  response: {
    ...nullableText8,
    description: "Their answer, such as Accepted, Tentative, Declined or None."
  }
};
var MeetingAttendeesStream = class extends TeamsStream {
  name = "meetingAttendees";
  primaryKey = ["accountId", "meetingId", "address"];
  jsonSchema = {
    type: "object",
    description: "One record per attendee of a meeting, for the meetings whose attendees the app holds. Primary key accountId, meetingId, address. An attendee removed from a meeting the app still holds is deleted.",
    properties: properties10,
    required: Object.keys(properties10)
  };
  covers(scan, key2) {
    return scan.holdsMeeting(key2.accountId, key2.meetingId);
  }
  rows(scan) {
    return scan.clients.flatMap(({ account: account2, meetings }) => meetings.flatMap(({ id: id23, attendees }) => attendees.map((attendee) => ({
      accountId: account2.userId,
      meetingId: id23,
      ...attendee
    }))));
  }
  records(row) {
    return [row];
  }
};

// packages/sources/microsoft/teams/dist/streams/meetings-stream.js
var { id: id11, accountId: accountId10, instant: instant2, nullableText: nullableText9, nullableBoolean: nullableBoolean5, nullablePreciseInstant: nullablePreciseInstant2 } = teamsFields;
var properties11 = {
  accountId: accountId10,
  id: { ...id11, description: "The calendar event\u2019s ID in Exchange." },
  iCalUid: {
    ...nullableText9,
    description: "Its iCalendar UID, shared by every occurrence of a series."
  },
  seriesMasterId: {
    ...nullableText9,
    description: "For an occurrence, its series (meetings.id of the series)."
  },
  eventType: {
    ...nullableText9,
    description: "Occurrence or Exception for a recurring meeting\u2019s occurrence, as moved or changed."
  },
  subject: { ...nullableText9, description: "Its title." },
  startAt: { ...instant2, description: "When it starts." },
  endAt: { ...instant2, description: "When it ends." },
  timeZone: {
    ...nullableText9,
    description: "The time zone it was scheduled in, as Exchange names it."
  },
  location: { ...nullableText9, description: "Where it takes place." },
  organizerName: { ...nullableText9, description: "Who organizes it." },
  organizerAddress: {
    ...nullableText9,
    description: "The organizer\u2019s email address."
  },
  isOnlineMeeting: {
    ...nullableBoolean5,
    description: "Whether it is a Teams meeting."
  },
  joinUrl: { ...nullableText9, description: "The link to join it." },
  conversationId: {
    ...nullableText9,
    description: "Its meeting chat (conversations.id)."
  },
  myResponse: {
    ...nullableText9,
    description: "The user\u2019s answer: Accepted, Tentative, Declined, NotResponded or Organizer."
  },
  showAs: {
    ...nullableText9,
    description: "How it shows the user\u2019s time: Busy, Tentative, Free\u2026."
  },
  isCancelled: {
    type: "boolean",
    description: "Whether the organizer cancelled it."
  },
  bodyPreview: {
    ...nullableText9,
    description: "The start of its invitation\u2019s text."
  },
  modifiedAt: {
    ...nullablePreciseInstant2,
    description: "When it was last changed."
  }
};
var MeetingsStream = class extends TeamsStream {
  name = "meetings";
  primaryKey = ["accountId", "id"];
  // The calendar keeps the meetings of a span around today that it does not
  // record, so a meeting gone from it may only have left the span; a
  // cancelled meeting says so in isCancelled.
  emitsDeletes = void 0;
  jsonSchema = {
    type: "object",
    description: "One record per meeting on the account\u2019s calendar that the app has held: it keeps the meetings of a few weeks around today. Primary key accountId, id. Every meeting held stays; a cancelled one says so in isCancelled.",
    properties: properties11,
    required: Object.keys(properties11)
  };
  rows(scan) {
    return scan.clients.flatMap(({ account: account2, meetings }) => meetings.map((meeting) => ({ accountId: account2.userId, meeting })));
  }
  records({ accountId: accountId17, meeting: { attendees: _attendees, ...meeting } }) {
    return [{ accountId: accountId17, ...meeting }];
  }
};

// packages/sources/microsoft/teams/dist/streams/message-child-stream.js
var { id: id12, accountId: accountId11, conversationId: conversationId3 } = teamsFields;
var messageKey = {
  accountId: accountId11,
  conversationId: conversationId3,
  threadId: { ...id12, description: "The message\u2019s thread (messages.threadId)." },
  messageId: { ...id12, description: "The message (messages.id)." }
};
var MessageChildStream = class extends TeamsStream {
  covers(scan, key2) {
    return scan.holds(key2.accountId, key2.conversationId, key2.threadId, key2.messageId);
  }
  rows(scan) {
    return scan.clients.flatMap((client) => scan.messages(client).flatMap((message) => this.children(message).map((child) => ({
      key: {
        accountId: client.account.userId,
        conversationId: message.conversationId,
        threadId: message.threadId,
        messageId: message.id
      },
      child
    }))));
  }
};

// packages/sources/microsoft/teams/dist/streams/message-files-stream.js
var { id: id13, nullableText: nullableText10 } = teamsFields;
var properties12 = {
  ...messageKey,
  fileId: { ...id13, description: "Teams\u2019 ID for the file in the message." },
  name: { ...nullableText10, description: "The file\u2019s name." },
  fileType: { ...nullableText10, description: "Its extension, such as pdf." },
  title: { ...nullableText10, description: "The title the message shows." },
  url: {
    ...nullableText10,
    description: "Where the file is, in OneDrive or SharePoint; Teams keeps no copy on this Mac."
  },
  siteUrl: {
    ...nullableText10,
    description: "The OneDrive or SharePoint site that holds it."
  },
  shareUrl: { ...nullableText10, description: "A sharing link to it." },
  service: {
    ...nullableText10,
    description: "Where it lives: teams for a channel\u2019s files, p2p for a chat\u2019s, shared from the sender\u2019s OneDrive."
  }
};
var MessageFilesStream = class extends MessageChildStream {
  name = "messageFiles";
  primaryKey = [
    "accountId",
    "conversationId",
    "threadId",
    "messageId",
    "fileId"
  ];
  jsonSchema = {
    type: "object",
    description: "One record per file attached to a message; the file itself stays in OneDrive or SharePoint. Primary key accountId, conversationId, threadId, messageId, fileId. A file removed from a message the app still holds is deleted.",
    properties: properties12,
    required: Object.keys(properties12)
  };
  children({ files }) {
    return files;
  }
  records({ key: key2, child: { id: id23, ...file2 } }) {
    return [{ ...key2, fileId: id23, ...file2 }];
  }
};

// packages/sources/microsoft/teams/dist/streams/message-links-stream.js
var { id: id14, position, nullableText: nullableText11 } = teamsFields;
var properties13 = {
  ...messageKey,
  position: {
    ...position,
    description: "The link\u2019s place among the message\u2019s links, from 0."
  },
  url: { ...id14, description: "The address." },
  title: { ...nullableText11, description: "The title of its preview." },
  description: {
    ...nullableText11,
    description: "The description of its preview."
  },
  previewUrl: {
    ...nullableText11,
    description: "The image of its preview."
  }
};
var MessageLinksStream = class extends MessageChildStream {
  name = "messageLinks";
  primaryKey = [
    "accountId",
    "conversationId",
    "threadId",
    "messageId",
    "position"
  ];
  jsonSchema = {
    type: "object",
    description: "One record per link Teams found in a message, with the preview it shows. Primary key accountId, conversationId, threadId, messageId, position. A link edited out of a message the app still holds is deleted.",
    properties: properties13,
    required: Object.keys(properties13)
  };
  children({ links }) {
    return links;
  }
  records({ key: key2, child: link2 }) {
    return [{ ...key2, ...link2 }];
  }
};

// packages/sources/microsoft/teams/dist/streams/message-mentions-stream.js
var { id: id15, position: position2, nullableText: nullableText12 } = teamsFields;
var properties14 = {
  ...messageKey,
  position: {
    ...position2,
    description: "The mention\u2019s number in the message, which its content refers to as itemid."
  },
  mentionedId: {
    ...id15,
    description: "Who or what is mentioned: a person (people.mri), or the conversation, team or tag for everyone, channel, team and tag mentions."
  },
  kind: {
    ...nullableText12,
    description: "person, everyone, channel, team or tag."
  },
  displayName: {
    ...nullableText12,
    description: "The name the mention shows."
  }
};
var MessageMentionsStream = class extends MessageChildStream {
  name = "messageMentions";
  primaryKey = [
    "accountId",
    "conversationId",
    "threadId",
    "messageId",
    "position"
  ];
  jsonSchema = {
    type: "object",
    description: "One record per mention in a message. Primary key accountId, conversationId, threadId, messageId, position. A mention edited out of a message the app still holds is deleted.",
    properties: properties14,
    required: Object.keys(properties14)
  };
  children({ mentions }) {
    return mentions;
  }
  records({ key: key2, child: mention2 }) {
    return [{ ...key2, ...mention2 }];
  }
};

// packages/sources/microsoft/teams/dist/streams/message-quotes-stream.js
var { id: id16, position: position3, nullableText: nullableText13, nullableInstant: nullableInstant5 } = teamsFields;
var properties15 = {
  ...messageKey,
  position: {
    ...position3,
    description: "The quote\u2019s place among the message\u2019s quotes, from 0."
  },
  quotedMessageId: {
    ...id16,
    description: "The message it replies to (messages.id)."
  },
  quotedSenderId: {
    ...nullableText13,
    description: "Who sent the quoted message (people.mri)."
  },
  quotedSentAt: {
    ...nullableInstant5,
    description: "When the quoted message was sent."
  },
  quotedThreadId: {
    ...nullableText13,
    description: "The quoted message\u2019s thread, for one in a channel."
  }
};
var MessageQuotesStream = class extends MessageChildStream {
  name = "messageQuotes";
  primaryKey = [
    "accountId",
    "conversationId",
    "threadId",
    "messageId",
    "position"
  ];
  jsonSchema = {
    type: "object",
    description: "One record per earlier message a message quotes in reply. Primary key accountId, conversationId, threadId, messageId, position. A quote removed from a message the app still holds is deleted.",
    properties: properties15,
    required: Object.keys(properties15)
  };
  children({ quotes }) {
    return quotes.map((quote2, position5) => ({ position: position5, quote: quote2 }));
  }
  records({ key: key2, child: { position: position5, quote: quote2 } }) {
    return [
      {
        ...key2,
        position: position5,
        quotedMessageId: quote2.messageId,
        quotedSenderId: quote2.senderId,
        quotedSentAt: quote2.sentAt,
        quotedThreadId: quote2.threadId
      }
    ];
  }
};

// packages/sources/microsoft/teams/dist/streams/message-reactions-stream.js
var { id: id17, nullableInstant: nullableInstant6 } = teamsFields;
var properties16 = {
  ...messageKey,
  emoji: {
    ...id17,
    description: "The reaction as Teams names it, such as like, heart or laugh."
  },
  userId: { ...id17, description: "Who reacted (people.mri)." },
  reactedAt: { ...nullableInstant6, description: "When they reacted." }
};
var MessageReactionsStream = class extends MessageChildStream {
  name = "messageReactions";
  primaryKey = [
    "accountId",
    "conversationId",
    "threadId",
    "messageId",
    "emoji",
    "userId"
  ];
  jsonSchema = {
    type: "object",
    description: "One record per person\u2019s reaction to a message. Primary key accountId, conversationId, threadId, messageId, emoji, userId. A reaction taken back from a message the app still holds is deleted; reactions of a message the app dropped from its cache stay.",
    properties: properties16,
    required: Object.keys(properties16)
  };
  children({ reactions: reactions2 }) {
    return reactions2;
  }
  records({ key: key2, child: reaction }) {
    return [{ ...key2, ...reaction }];
  }
};

// packages/sources/microsoft/teams/dist/streams/messages-stream.js
var { id: id18, accountId: accountId12, conversationId: conversationId4, instant: instant3, nullableInstant: nullableInstant7, nullableText: nullableText14, nullableBoolean: nullableBoolean6 } = teamsFields;
var properties17 = {
  accountId: accountId12,
  conversationId: conversationId4,
  threadId: {
    ...id18,
    description: "The thread it starts or belongs to (messages.id of its first message): the message itself, except for a reply in a channel."
  },
  id: {
    ...id18,
    description: "Teams\u2019 ID for the message within its conversation: when the service received it, in milliseconds since 1970."
  },
  sentAt: { ...instant3, description: "When the service received it." },
  senderId: {
    ...nullableText14,
    description: "Who sent it: 8:orgid:<id> for a person (people.mri), 28:<id> for a bot."
  },
  senderName: {
    ...nullableText14,
    description: "The sender\u2019s name as the message carries it."
  },
  messageType: {
    ...id18,
    description: "Teams\u2019 kind of message, such as RichText/Html or Text for what people write, Event/Call, RichText/Media_CallRecording, or ThreadActivity/AddMember for a change to the conversation."
  },
  contentType: {
    ...nullableText14,
    description: "How content is written, such as Text or RichText/Html."
  },
  content: {
    ...nullableText14,
    description: "The message as Teams holds it: HTML for rich text, XML for events; NULL once deleted."
  },
  subject: {
    ...nullableText14,
    description: "The subject a channel post was given."
  },
  importance: {
    ...nullableText14,
    description: "high or urgent when the sender marked it so."
  },
  editedAt: { ...nullableInstant7, description: "When it was last edited." },
  deletedAt: {
    ...nullableInstant7,
    description: "When it was deleted; Teams keeps a deleted message\u2019s place."
  },
  isFromUser: {
    ...nullableBoolean6,
    description: "Whether the account\u2019s user sent it; NULL for a message Teams keeps only as a conversation\u2019s newest."
  },
  cardsJson: {
    ...nullableText14,
    description: "The adaptive cards it carries, as the JSON Teams holds."
  },
  pinnedBy: {
    ...nullableText14,
    description: "Who pinned it to the conversation (people.mri)."
  },
  pinnedAt: { ...nullableInstant7, description: "When it was pinned." }
};
var MessagesStream = class extends TeamsStream {
  name = "messages";
  primaryKey = ["accountId", "conversationId", "threadId", "id"];
  jsonSchema = {
    type: "object",
    description: "One record per chat and channel message the app has held, and the newest message of every conversation: Teams keeps only the parts of each conversation it loaded, so older history is here only if it was loaded while this import ran. Primary key accountId, conversationId, threadId, id. A message the app no longer lists inside a part of the conversation it still holds was deleted and is deleted here; one the app dropped from its cache stays.",
    properties: properties17,
    required: Object.keys(properties17)
  };
  covers(scan, key2) {
    return scan.holds(key2.accountId, key2.conversationId, key2.threadId, key2.id);
  }
  rows(scan) {
    return scan.clients.flatMap((client) => scan.messages(client).map((message) => ({ accountId: client.account.userId, message })));
  }
  records({ accountId: accountId17, message: { reactions: _reactions, mentions: _mentions, files: _files, links: _links, quotes: _quotes, ...message } }) {
    return [{ accountId: accountId17, ...message }];
  }
};

// packages/sources/microsoft/teams/dist/streams/people-stream.js
var { id: id19, accountId: accountId13, nullableText: nullableText15 } = teamsFields;
var properties18 = {
  accountId: accountId13,
  mri: {
    ...id19,
    description: "The person\u2019s Teams ID, 8:orgid:<objectId>, or a bot\u2019s, 28:<id>: what messages, members and calls name them by."
  },
  objectId: {
    ...nullableText15,
    description: "Their Microsoft Entra object ID."
  },
  type: { ...nullableText15, description: "ADUser for a person, BOT for a bot." },
  displayName: { ...nullableText15, description: "Their name." },
  givenName: { ...nullableText15, description: "Their first name." },
  surname: { ...nullableText15, description: "Their last name." },
  email: { ...nullableText15, description: "Their email address." },
  userPrincipalName: {
    ...nullableText15,
    description: "The name they sign in with."
  },
  jobTitle: { ...nullableText15, description: "Their job title." },
  department: { ...nullableText15, description: "Their department." },
  companyName: { ...nullableText15, description: "Their company." },
  officeLocation: { ...nullableText15, description: "Their office." },
  userLocation: {
    ...nullableText15,
    description: "Where they work, as their organization records it."
  },
  tenantName: {
    ...nullableText15,
    description: "The organization they belong to."
  },
  userType: {
    ...nullableText15,
    description: "Member, or Guest for someone from outside."
  }
};
var PeopleStream = class extends TeamsStream {
  name = "people";
  primaryKey = ["accountId", "mri"];
  // The app looks people up as it needs them and drops them from its cache
  // without a trace, so a person gone from it was not deleted.
  emitsDeletes = void 0;
  jsonSchema = {
    type: "object",
    description: "One record per person or bot the app has looked up in the directory, with what the directory said then. Primary key accountId, mri. The app keeps only people it has looked up lately; everyone it has held stays.",
    properties: properties18,
    required: Object.keys(properties18)
  };
  rows(scan) {
    return scan.clients.flatMap(({ account: account2, people }) => people.map((person) => ({ accountId: account2.userId, person })));
  }
  records({ accountId: accountId17, person }) {
    return [{ accountId: accountId17, ...person }];
  }
};

// packages/sources/microsoft/teams/dist/streams/pins-stream.js
var { id: id20, position: position4, accountId: accountId14, conversationId: conversationId5 } = teamsFields;
var properties19 = {
  accountId: accountId14,
  conversationId: conversationId5,
  messageId: {
    ...id20,
    description: "The pinned message (messages.id), which messages holds when the app has loaded it, with who pinned it and when."
  },
  position: {
    ...position4,
    description: "Its place among the conversation\u2019s pins, from 0."
  }
};
var PinsStream = class extends TeamsStream {
  name = "pins";
  primaryKey = ["accountId", "conversationId", "messageId"];
  jsonSchema = {
    type: "object",
    description: "One record per message pinned to a conversation, as the conversation lists them. Primary key accountId, conversationId, messageId. An unpinned message is deleted.",
    properties: properties19,
    required: Object.keys(properties19)
  };
  rows(scan) {
    return scan.clients.flatMap(({ account: account2, conversations }) => conversations.filter(({ id: id23 }) => scan.conversationSelected(id23)).flatMap(({ id: id23, pinnedMessageIds }) => pinnedMessageIds.map((messageId, position5) => ({
      accountId: account2.userId,
      conversationId: id23,
      messageId,
      position: position5
    }))));
  }
  records(row) {
    return [row];
  }
};

// packages/sources/microsoft/teams/dist/streams/saved-messages-stream.js
var { id: id21, accountId: accountId15, instant: instant4, nullableText: nullableText16 } = teamsFields;
var properties20 = {
  accountId: accountId15,
  feed: {
    ...id21,
    description: "saved, or starred for a message saved before Teams named it so."
  },
  id: {
    ...id21,
    description: "The entry\u2019s ID in Teams\u2019 saved list, when it was saved in milliseconds since 1970."
  },
  conversationId: {
    ...nullableText16,
    description: "The saved message\u2019s conversation (conversations.id)."
  },
  threadId: {
    ...nullableText16,
    description: "Its thread (messages.threadId)."
  },
  messageId: {
    ...nullableText16,
    description: "The saved message (messages.id)."
  },
  savedAt: { ...instant4, description: "When the user saved it." }
};
var SavedMessagesStream = class extends TeamsStream {
  name = "savedMessages";
  primaryKey = ["accountId", "feed", "id"];
  jsonSchema = {
    type: "object",
    description: "One record per message the user saved, that the app holds. Primary key accountId, feed, id. A message unsaved inside the part of the list the app still holds is deleted.",
    properties: properties20,
    required: Object.keys(properties20)
  };
  covers(scan, key2) {
    return scan.holds(key2.accountId, `48:${String(key2.feed)}`, key2.id, key2.id);
  }
  rows(scan) {
    return scan.clients.flatMap(({ account: account2, savedMessages }) => savedMessages.map((saved) => ({ accountId: account2.userId, saved })));
  }
  records({ accountId: accountId17, saved }) {
    return [{ accountId: accountId17, ...saved }];
  }
};

// packages/sources/microsoft/teams/dist/streams/searches-stream.js
var { id: id22, accountId: accountId16, nullableInstant: nullableInstant8 } = teamsFields;
var properties21 = {
  accountId: accountId16,
  id: { ...id22, description: "Teams\u2019 ID for the entry." },
  query: { ...id22, description: "What the user searched for." },
  searchedAt: {
    ...nullableInstant8,
    description: "When the user last ran it."
  }
};
var SearchesStream = class extends TeamsStream {
  name = "searches";
  primaryKey = ["accountId", "id"];
  // Teams keeps only the latest searches and drops older ones without a
  // trace.
  emitsDeletes = void 0;
  jsonSchema = {
    type: "object",
    description: "One record per search the user ran in Teams that the app has kept. Primary key accountId, id. Teams keeps only its latest searches; every search held stays.",
    properties: properties21,
    required: Object.keys(properties21)
  };
  rows(scan) {
    return scan.clients.flatMap(({ account: account2, searches }) => searches.map((search) => ({ accountId: account2.userId, ...search })));
  }
  records(row) {
    return [row];
  }
};

// packages/sources/microsoft/teams/dist/teams-scan.js
var TeamsScan = class {
  #clients;
  #scope;
  #kept;
  constructor(clients, scope) {
    this.#clients = clients;
    this.#scope = scope;
    this.#kept = new Map(clients.map((client) => [client.account.userId, client]));
  }
  get clients() {
    return this.#clients.filter(({ account: account2 }) => selected(this.#scope.accountIds, account2.userId));
  }
  // Whether the app still keeps this account: one it no longer keeps, such
  // as one signed out of, says nothing about its rows, so they stay.
  keeps(accountId17) {
    return typeof accountId17 === "string" && this.#kept.has(accountId17);
  }
  // Whether the app holds this part of a conversation's history, so a
  // message it no longer lists there was deleted rather than dropped from its
  // cache.
  holds(accountId17, conversationId6, threadId, messageId) {
    return typeof accountId17 === "string" && typeof conversationId6 === "string" && typeof threadId === "string" && typeof messageId === "string" && (this.#kept.get(accountId17)?.holds(conversationId6, threadId, messageId) ?? false);
  }
  // Whether the app keeps this conversation's member list, so a member it no
  // longer lists there left.
  holdsMembers(accountId17, conversationId6) {
    return typeof accountId17 === "string" && (this.#kept.get(accountId17)?.conversations.some(({ id: id23, members: members2 }) => id23 === conversationId6 && members2 !== null) ?? false);
  }
  // Whether the app still holds this meeting, so an attendee it no longer
  // lists there was removed.
  holdsMeeting(accountId17, meetingId) {
    return typeof accountId17 === "string" && (this.#kept.get(accountId17)?.meetings.some(({ id: id23 }) => id23 === meetingId) ?? false);
  }
  holdsApps(accountId17, scope, scopeId) {
    return typeof accountId17 === "string" && typeof scope === "string" && typeof scopeId === "string" && (this.#kept.get(accountId17)?.holdsApps(scope, scopeId) ?? false);
  }
  conversationSelected(conversationId6) {
    return selected(this.#scope.collectionIds, conversationId6);
  }
  messages(client) {
    return client.messages.filter(({ conversationId: conversationId6, sentAt }) => this.conversationSelected(conversationId6) && withinDates(this.#scope, sentAt));
  }
  // Everything was read when the scan opened; nothing stays open.
  async [Symbol.asyncDispose]() {
  }
};

// packages/sources/microsoft/teams/dist/teams-source.js
var readers = {
  accounts: new AccountsStream(),
  conversations: new ConversationsStream(),
  conversationMembers: new ConversationMembersStream(),
  messages: new MessagesStream(),
  messageReactions: new MessageReactionsStream(),
  messageMentions: new MessageMentionsStream(),
  messageFiles: new MessageFilesStream(),
  messageLinks: new MessageLinksStream(),
  messageQuotes: new MessageQuotesStream(),
  pins: new PinsStream(),
  callLogs: new CallLogsStream(),
  callParticipants: new CallParticipantsStream(),
  activities: new ActivitiesStream(),
  savedMessages: new SavedMessagesStream(),
  people: new PeopleStream(),
  meetings: new MeetingsStream(),
  meetingAttendees: new MeetingAttendeesStream(),
  folders: new FoldersStream(),
  folderConversations: new FolderConversationsStream(),
  installedApps: new InstalledAppsStream(),
  searches: new SearchesStream()
};
var catalog = new Catalog(Object.values(readers).map((reader) => reader.describe()));
var readersByName = new Map(Object.values(readers).map((reader) => [reader.name, reader]));
var pollIntervalMs = 1e3;
var TeamsSource = class extends Source {
  identity;
  catalog = catalog;
  accounts = readers.accounts.describe();
  conversations = readers.conversations.describe();
  conversationMembers = readers.conversationMembers.describe();
  messages = readers.messages.describe();
  messageReactions = readers.messageReactions.describe();
  messageMentions = readers.messageMentions.describe();
  messageFiles = readers.messageFiles.describe();
  messageLinks = readers.messageLinks.describe();
  messageQuotes = readers.messageQuotes.describe();
  pins = readers.pins.describe();
  callLogs = readers.callLogs.describe();
  callParticipants = readers.callParticipants.describe();
  activities = readers.activities.describe();
  savedMessages = readers.savedMessages.describe();
  people = readers.people.describe();
  meetings = readers.meetings.describe();
  meetingAttendees = readers.meetingAttendees.describe();
  folders = readers.folders.describe();
  folderConversations = readers.folderConversations.describe();
  installedApps = readers.installedApps.describe();
  searches = readers.searches.describe();
  directory;
  scope;
  #store;
  constructor(directory = teamsDirectory(), scope = {}) {
    super();
    this.directory = directory;
    this.scope = scope;
    this.#store = new TeamsStore(directory);
    this.identity = `microsoft-teams:${directory}`;
    Object.freeze(this);
  }
  async open() {
    return new TeamsScan(await this.#store.clients(), this.scope);
  }
  failureType(error) {
    return error instanceof TeamsUnavailableError ? "config" : "system";
  }
  coverage(_stream) {
    return {
      description: "What the Microsoft Teams app keeps on this Mac for each signed-in work or school account: all its conversations, members and folders; only the messages, call history and activity the app has loaded; the people it has looked up; and the meetings of a few weeks around today.",
      selection: this.scope
    };
  }
  // The web client writes its caches as it works, so a write wakes every
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
      throw new Error(`Microsoft Teams has no stream ${stream.name}`);
    const records = reader.read(scan);
    if (configuration.syncMode === "full_refresh") {
      for (const data of records)
        yield { stream: stream.name, data };
      return;
    }
    yield* diffSnapshot(stream, records, state, stream.emitsDeletes ? { covers: ({ key: key2 }) => reader.covers(scan, key2) } : {});
  }
};

// packages/connectors/apple/teams/dist/teams-connector.js
var account = (row) => {
  const domains = Array.isArray(row.tenantDomains) ? row.tenantDomains : [];
  return String(domains[0] ?? row.tenantId);
};
var conversation = (row, rows) => {
  if (row.type === "Topic") {
    const team = rows.get("conversations")?.find(({ id: id23 }) => id23 === row.teamId);
    const channel = String(row.topic ?? "channel");
    return team === void 0 ? channel : `${String(team.teamName ?? team.topic ?? "team")} / ${channel}`;
  }
  if (row.type === "Space")
    return String(row.teamName ?? row.topic ?? `team ${byId(row)}`);
  if (row.type === "StreamOfNotes")
    return "Notes";
  return String(row.topic ?? row.title ?? `${String(row.type)} ${byId(row)}`);
};
var TeamsConnector = class extends AppleConnector {
  datedBy = "date sent";
  fullDiskAccess = true;
  note = "Teams keeps only the messages it has loaded on this Mac, so older history is imported only once Teams loads it.";
  choices = [
    accounts(account),
    {
      stream: "conversations",
      scope: "collectionIds",
      title: "conversations",
      id: byId,
      label: conversation
    }
  ];
  unscoped = [];
  storeCopies = [];
  access() {
    return "Open Microsoft Teams, sign in and let it run: it saves what it loads as you use it, and only what it has loaded on this Mac is imported.";
  }
  source(scope) {
    return new TeamsSource(void 0, scope);
  }
};
export {
  TeamsConnector as default
};
