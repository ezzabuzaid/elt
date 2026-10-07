import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  eventKitFields
} from "../../chunks/chunk-YUEL2AIL.mjs";
import {
  withinDates
} from "../../chunks/chunk-YM7ADF2O.mjs";
import {
  AppDatabase,
  AppDatabaseVersion
} from "../../chunks/chunk-SDFTRGL6.mjs";
import {
  localAppleStoreCoverage
} from "../../chunks/chunk-BRJ4TKR5.mjs";
import {
  AppleConnector
} from "../../chunks/chunk-TA2XBELF.mjs";
import {
  Catalog,
  Source,
  Stream,
  diffSnapshot,
  validateRecords
} from "../../chunks/chunk-WXJ5Y2PE.mjs";
import {
  __callDispose,
  __using
} from "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/sources/apple/call-history/dist/apple-call-history-source.js
import { setInterval } from "node:timers/promises";

// packages/sdks/apple/call-history/dist/call.js
var kinds = /* @__PURE__ */ new Map([
  [1, "phone"],
  [8, "faceTimeVideo"],
  [16, "faceTimeAudio"]
]);
var categories = /* @__PURE__ */ new Map([
  [1, "audio"],
  [2, "video"]
]);
function callKind(code2) {
  return code2 === null ? null : kinds.get(code2) ?? null;
}
function callCategory(code2) {
  return code2 === null ? null : categories.get(code2) ?? null;
}

// packages/sdks/apple/call-history/dist/errors.js
var CallHistoryUnavailableError = class extends Error {
  name = "CallHistoryUnavailableError";
  constructor(path, cause) {
    super(`The call history store at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security.`, { cause });
  }
};
var CallHistorySchemaError = class extends Error {
  name = "CallHistorySchemaError";
  constructor(path, missing) {
    super(`The call history store at ${path} has a layout this reader does not read (missing ${missing.join(", ")}).`);
  }
};

// packages/sdks/apple/call-history/dist/call-history-snapshot.js
var requiredColumns = {
  ZCALLRECORD: [
    "Z_PK",
    "ZUNIQUE_ID",
    "ZDATE",
    "ZDURATION",
    "ZSERVICE_PROVIDER",
    "ZCALLTYPE",
    "ZCALL_CATEGORY",
    "ZORIGINATED",
    "ZANSWERED",
    "ZREAD",
    "ZHASMESSAGE",
    "ZADDRESS",
    "ZNAME",
    "ZLOCATION",
    "ZISO_COUNTRY_CODE",
    "ZHANDLE_TYPE",
    "ZINITIATOR",
    "ZNUMBER_AVAILABILITY",
    "ZDISCONNECTED_CAUSE",
    "ZFILTERED_OUT_REASON",
    "ZBLOCKEDBYEXTENSION",
    "ZBLOCKEDBYEXTENSIONNAME",
    "ZIDENTITYEXTENSION",
    "ZCALLDIRECTORYIDENTITYTYPE",
    "ZJUNKCONFIDENCE",
    "ZJUNKIDENTIFICATIONCATEGORY",
    "ZVERIFICATIONSTATUS",
    "ZCOMMUNICATIONTRUSTSCORE",
    "ZAUTOANSWEREDREASON",
    "ZSCREENSHARINGTYPE",
    "ZORIGINATINGUITYPE",
    "ZORIGINATINGDEVICENAME",
    "ZFACE_TIME_DATA",
    "ZWASEMERGENCYCALL",
    "ZUSEDEMERGENCYVIDEOSTREAMING",
    "ZDIDENABLETRANSLATION",
    "ZNEEDEDSCANNOUNCEMENT",
    "ZCONVERSATIONID",
    "ZLOCALPARTICIPANTUUID",
    "ZOUTGOINGLOCALPARTICIPANTUUID",
    "ZPARTICIPANTGROUPUUID",
    "ZREMINDERUUID",
    "ZIMAGEURL",
    "ZSAINT_DAVIDS_1",
    "ZSAINT_DAVIDS_2"
  ],
  ZHANDLE: ["Z_PK", "ZTYPE", "ZVALUE", "ZNORMALIZEDVALUE"],
  ZCALLDBPROPERTIES: [
    "Z_PK",
    "ZTIMER_ALL",
    "ZTIMER_INCOMING",
    "ZTIMER_OUTGOING",
    "ZTIMER_LAST",
    "ZTIMER_LIFETIME"
  ],
  ZEMERGENCYMEDIAITEM: [
    "Z_PK",
    "ZUPLOADEDFORCALL",
    "ZEMERGENCYMEDIATYPE",
    "ZASSETID"
  ],
  ZSAINTDAVIDSCOUNTS: ["Z_PK", "ZCALL", "ZTYPE", "ZCOUNT"]
};
var CallHistorySnapshot = class {
  #database;
  constructor(path) {
    this.#database = new AppDatabase(path, CallHistoryUnavailableError);
    this.#database.requireColumns(requiredColumns, CallHistorySchemaError);
  }
  calls() {
    return this.#database.all(`SELECT record.ZUNIQUE_ID AS id,
                record.ZDATE AS startedAt,
                record.ZDURATION AS duration,
                record.ZSERVICE_PROVIDER AS serviceProvider,
                record.ZCALLTYPE AS kindCode,
                record.ZCALL_CATEGORY AS categoryCode,
                record.ZORIGINATED AS outgoing, record.ZANSWERED AS answered,
                record.ZREAD AS read, record.ZHASMESSAGE AS hasMessage,
                record.ZADDRESS AS address, record.ZNAME AS name,
                record.ZLOCATION AS location,
                record.ZISO_COUNTRY_CODE AS isoCountryCode,
                record.ZHANDLE_TYPE AS handleType,
                initiator.ZTYPE AS initiatorType,
                initiator.ZVALUE AS initiatorValue,
                initiator.ZNORMALIZEDVALUE AS initiatorNormalizedValue,
                record.ZNUMBER_AVAILABILITY AS numberAvailability,
                record.ZDISCONNECTED_CAUSE AS disconnectedCause,
                record.ZFILTERED_OUT_REASON AS filteredOutReason,
                record.ZBLOCKEDBYEXTENSION AS blockedByExtension,
                record.ZBLOCKEDBYEXTENSIONNAME AS blockedByExtensionName,
                record.ZIDENTITYEXTENSION AS identityExtension,
                record.ZCALLDIRECTORYIDENTITYTYPE AS callDirectoryIdentityType,
                record.ZJUNKCONFIDENCE AS junkConfidence,
                record.ZJUNKIDENTIFICATIONCATEGORY AS junkIdentificationCategory,
                record.ZVERIFICATIONSTATUS AS verificationStatus,
                record.ZCOMMUNICATIONTRUSTSCORE AS communicationTrustScore,
                record.ZAUTOANSWEREDREASON AS autoAnsweredReason,
                record.ZSCREENSHARINGTYPE AS screenSharingType,
                record.ZORIGINATINGUITYPE AS originatingUIType,
                record.ZORIGINATINGDEVICENAME AS originatingDeviceName,
                record.ZFACE_TIME_DATA AS faceTimeData,
                record.ZWASEMERGENCYCALL AS wasEmergencyCall,
                record.ZUSEDEMERGENCYVIDEOSTREAMING AS usedEmergencyVideoStreaming,
                record.ZDIDENABLETRANSLATION AS didEnableTranslation,
                record.ZNEEDEDSCANNOUNCEMENT AS neededSCAnnouncement,
                record.ZCONVERSATIONID AS conversationId,
                record.ZLOCALPARTICIPANTUUID AS localParticipantUuid,
                record.ZOUTGOINGLOCALPARTICIPANTUUID AS outgoingLocalParticipantUuid,
                record.ZPARTICIPANTGROUPUUID AS participantGroupUuid,
                record.ZREMINDERUUID AS reminderUuid,
                record.ZIMAGEURL AS imageUrl,
                record.ZSAINT_DAVIDS_1 AS saintDavids1,
                record.ZSAINT_DAVIDS_2 AS saintDavids2
         FROM ZCALLRECORD AS record
         LEFT JOIN ZHANDLE AS initiator ON initiator.Z_PK = record.ZINITIATOR
         ORDER BY record.Z_PK`).map((row) => {
      const kindCode = number(row.kindCode);
      const categoryCode = number(row.categoryCode);
      return {
        id: required(row.id, "A call has no unique ID"),
        startedAt: instant(row.startedAt),
        duration: number(row.duration),
        serviceProvider: string(row.serviceProvider),
        kind: callKind(kindCode),
        kindCode,
        category: callCategory(categoryCode),
        categoryCode,
        outgoing: flag(row.outgoing),
        answered: flag(row.answered),
        read: flag(row.read),
        hasMessage: flag(row.hasMessage),
        address: string(row.address),
        name: string(row.name),
        location: string(row.location),
        isoCountryCode: string(row.isoCountryCode),
        handleType: number(row.handleType),
        initiator: row.initiatorValue === null ? null : handle(row.initiatorType, row.initiatorValue, row.initiatorNormalizedValue),
        numberAvailability: number(row.numberAvailability),
        disconnectedCause: number(row.disconnectedCause),
        filteredOutReason: number(row.filteredOutReason),
        blockedByExtension: string(row.blockedByExtension),
        blockedByExtensionName: string(row.blockedByExtensionName),
        identityExtension: string(row.identityExtension),
        callDirectoryIdentityType: number(row.callDirectoryIdentityType),
        junkConfidence: number(row.junkConfidence),
        junkIdentificationCategory: string(row.junkIdentificationCategory),
        verificationStatus: number(row.verificationStatus),
        communicationTrustScore: number(row.communicationTrustScore),
        autoAnsweredReason: number(row.autoAnsweredReason),
        screenSharingType: number(row.screenSharingType),
        originatingUIType: number(row.originatingUIType),
        originatingDeviceName: string(row.originatingDeviceName),
        faceTimeData: number(row.faceTimeData),
        wasEmergencyCall: flag(row.wasEmergencyCall),
        usedEmergencyVideoStreaming: flag(row.usedEmergencyVideoStreaming),
        didEnableTranslation: flag(row.didEnableTranslation),
        neededSCAnnouncement: flag(row.neededSCAnnouncement),
        conversationId: uuid(row.conversationId),
        localParticipantUuid: uuid(row.localParticipantUuid),
        outgoingLocalParticipantUuid: uuid(row.outgoingLocalParticipantUuid),
        participantGroupUuid: uuid(row.participantGroupUuid),
        reminderUuid: uuid(row.reminderUuid),
        imageUrl: string(row.imageUrl),
        saintDavids1: number(row.saintDavids1),
        saintDavids2: string(row.saintDavids2)
      };
    });
  }
  participants() {
    const { table, call, handle: other } = this.#participantLinks();
    return this.#database.all(`SELECT record.ZUNIQUE_ID AS callId, handle.ZTYPE AS type,
                handle.ZVALUE AS value, handle.ZNORMALIZEDVALUE AS normalizedValue
         FROM "${table}" AS link
         JOIN ZCALLRECORD AS record ON record.Z_PK = link."${call}"
         JOIN ZHANDLE AS handle ON handle.Z_PK = link."${other}"
         ORDER BY record.Z_PK, handle.Z_PK`).map((row) => ({
      callId: required(row.callId, "A call has no unique ID"),
      handle: handle(row.type, row.value, row.normalizedValue)
    }));
  }
  timers() {
    return this.#database.all(`SELECT Z_PK AS id, ZTIMER_ALL AS "all", ZTIMER_INCOMING AS incoming,
                ZTIMER_OUTGOING AS outgoing, ZTIMER_LAST AS last,
                ZTIMER_LIFETIME AS lifetime
         FROM ZCALLDBPROPERTIES ORDER BY Z_PK`).map((row) => ({
      id: Number(row.id),
      all: number(row.all),
      incoming: number(row.incoming),
      outgoing: number(row.outgoing),
      last: number(row.last),
      lifetime: number(row.lifetime)
    }));
  }
  emergencyMediaItems() {
    return this.#database.all(`SELECT item.Z_PK AS id, record.ZUNIQUE_ID AS callId,
                item.ZEMERGENCYMEDIATYPE AS mediaType, item.ZASSETID AS assetId
         FROM ZEMERGENCYMEDIAITEM AS item
         LEFT JOIN ZCALLRECORD AS record ON record.Z_PK = item.ZUPLOADEDFORCALL
         ORDER BY item.Z_PK`).map((row) => ({
      id: Number(row.id),
      callId: string(row.callId),
      mediaType: number(row.mediaType),
      assetId: string(row.assetId)
    }));
  }
  saintDavidsCounts() {
    return this.#database.all(`SELECT counted.Z_PK AS id, record.ZUNIQUE_ID AS callId,
                counted.ZTYPE AS type, counted.ZCOUNT AS count
         FROM ZSAINTDAVIDSCOUNTS AS counted
         LEFT JOIN ZCALLRECORD AS record ON record.Z_PK = counted.ZCALL
         ORDER BY counted.Z_PK`).map((row) => ({
      id: Number(row.id),
      callId: string(row.callId),
      type: number(row.type),
      count: number(row.count)
    }));
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
  // Core Data names the join table and its columns after entity numbers that
  // change between macOS versions (Z_2REMOTEPARTICIPANTHANDLES today), so the
  // table is found by its name's end, its call column by its own, and the
  // handle column is the table's remaining one.
  #participantLinks() {
    const table = this.#database.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'Z_*REMOTEPARTICIPANTHANDLES'")[0]?.name;
    if (typeof table !== "string")
      throw new CallHistorySchemaError(this.#database.path, [
        "Z_*REMOTEPARTICIPANTHANDLES"
      ]);
    const columns = this.#database.all("SELECT name FROM pragma_table_info(?)", table).map(({ name }) => String(name));
    const call = columns.find((name) => name.endsWith("REMOTEPARTICIPANTCALLS"));
    const handle2 = columns.find((name) => name !== call);
    if (call === void 0 || handle2 === void 0 || columns.length !== 2)
      throw new CallHistorySchemaError(this.#database.path, [
        `${table}.Z_*REMOTEPARTICIPANTCALLS`
      ]);
    return { table, call, handle: handle2 };
  }
};
function handle(type, value, normalizedValue) {
  return {
    type: Number(type),
    value: required(value, "A call handle has no value"),
    normalizedValue: string(normalizedValue)
  };
}
function uuid(value) {
  if (value === null)
    return null;
  if (!(value instanceof Uint8Array) || value.length !== 16)
    throw new TypeError("A call UUID is not 16 bytes");
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase();
}
function required(value, missing) {
  if (typeof value !== "string")
    throw new TypeError(missing);
  return value;
}
function string(value) {
  return typeof value === "string" ? value : null;
}
function number(value) {
  return value === null ? null : Number(value);
}
function flag(value) {
  return value === null ? null : Number(value) === 1;
}
function instant(value) {
  if (value === null)
    return null;
  const micros = Math.round(Number(value) * 1e6);
  const seconds = Math.floor(micros / 1e6);
  const whole = new Date((seconds + 978307200) * 1e3).toISOString();
  return `${whole.slice(0, 19)}.${String(micros - seconds * 1e6).padStart(6, "0")}Z`;
}

// packages/sdks/apple/call-history/dist/call-history-store.js
import { homedir } from "node:os";
import { join } from "node:path";
var callHistoryStorePath = join(homedir(), "Library/Application Support/CallHistoryDB/CallHistory.storedata");
var CallHistoryStore = class {
  #path;
  constructor(path) {
    this.#path = path;
  }
  // The store as of one moment, so a call and its participants agree.
  open() {
    return new CallHistorySnapshot(this.#path);
  }
  // A probe whose current value changes with each commit to the store, such
  // as callhistoryd recording a call or syncing one from iCloud.
  version() {
    return new AppDatabaseVersion(this.#path, CallHistoryUnavailableError);
  }
};

// packages/sources/apple/call-history/dist/call-history-scan.js
var toMilliseconds = (instant2) => `${instant2.slice(0, 23)}Z`;
var CallHistoryScan = class {
  #snapshot;
  #scope;
  #calls;
  #callIds;
  #participants;
  #timers;
  #emergencyMediaItems;
  #saintDavidsCounts;
  constructor(snapshot, scope) {
    this.#snapshot = snapshot;
    this.#scope = scope;
  }
  get calls() {
    this.#calls ??= this.#snapshot.calls().filter(({ startedAt }) => withinDates(this.#scope, startedAt === null ? null : toMilliseconds(startedAt)));
    return this.#calls;
  }
  // Each call keeps its own copy of a handle, and nothing stops two copies of
  // one handle on a call; the first stands for both.
  get participants() {
    if (this.#participants === void 0) {
      const seen = /* @__PURE__ */ new Set();
      this.#participants = this.#snapshot.participants().filter((participant) => {
        const key = JSON.stringify([
          participant.callId,
          participant.handle.type,
          participant.handle.value
        ]);
        if (seen.has(key) || !this.#selected(participant.callId))
          return false;
        seen.add(key);
        return true;
      });
    }
    return this.#participants;
  }
  get timers() {
    this.#timers ??= this.#snapshot.timers();
    return this.#timers;
  }
  get emergencyMediaItems() {
    this.#emergencyMediaItems ??= this.#snapshot.emergencyMediaItems().filter(({ callId }) => callId === null || this.#selected(callId));
    return this.#emergencyMediaItems;
  }
  get saintDavidsCounts() {
    this.#saintDavidsCounts ??= this.#snapshot.saintDavidsCounts().filter(({ callId }) => callId === null || this.#selected(callId));
    return this.#saintDavidsCounts;
  }
  async [Symbol.asyncDispose]() {
    this.#snapshot[Symbol.dispose]();
  }
  #selected(callId) {
    if (this.#scope.startAt === void 0 && this.#scope.endAt === void 0)
      return true;
    this.#callIds ??= new Set(this.calls.map(({ id: id3 }) => id3));
    return this.#callIds.has(callId);
  }
};

// packages/sources/apple/call-history/dist/apple-call-history-stream.js
var callHistoryFields = {
  ...eventKitFields,
  nullableId: { type: ["string", "null"], minLength: 1 },
  nullableBoolean: { type: ["boolean", "null"] },
  nullableInteger: { type: ["integer", "null"] },
  nullableSeconds: { type: ["number", "null"], minimum: 0 },
  nullableInstant: {
    type: ["string", "null"],
    format: "date-time",
    precision: 6
  }
};
var AppleCallHistoryStream = class {
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
  read(scan) {
    return validateRecords(this, this.rows(scan).flatMap((row) => this.records(row)), "Call History");
  }
};

// packages/sources/apple/call-history/dist/streams/call-participants-stream.js
var { id, text, integer, nullableText } = callHistoryFields;
var properties = {
  callId: {
    ...id,
    description: "The call; refers to calls.id within this source."
  },
  type: {
    ...integer,
    description: "CallHistory\u2019s handle type code (ZHANDLE.ZTYPE), whose values Apple does not document."
  },
  value: {
    ...text,
    description: "The participant\u2019s phone number or address as the call recorded it (ZHANDLE.ZVALUE)."
  },
  normalizedValue: {
    ...nullableText,
    description: "value as CallHistory normalizes it for matching (ZHANDLE.ZNORMALIZEDVALUE); NULL when not stored."
  }
};
var CallParticipantsStream = class extends AppleCallHistoryStream {
  name = "callParticipants";
  primaryKey = ["callId", "type", "value"];
  jsonSchema = {
    type: "object",
    description: "One record per other party on a call (the call\u2019s remote participant handles): one for a one-to-one call, several for a group FaceTime call, none when the number was withheld. Primary key callId, type, value. CallHistory keeps a copy of each handle per call, so a participant names a party to that call, not a contact.",
    properties,
    required: Object.keys(properties)
  };
  rows(scan) {
    return scan.participants;
  }
  records(participant) {
    return [
      {
        callId: participant.callId,
        type: participant.handle.type,
        value: participant.handle.value,
        normalizedValue: participant.handle.normalizedValue
      }
    ];
  }
};

// packages/sources/apple/call-history/dist/streams/call-timers-stream.js
var { integer: integer2, nullableSeconds } = callHistoryFields;
var timer = (what, column) => `${what}, in seconds (ZCALLDBPROPERTIES.${column}); NULL when not stored.`;
var properties2 = {
  id: {
    ...integer2,
    description: "The store\u2019s row number for these totals (ZCALLDBPROPERTIES.Z_PK); the primary key. The store keeps one row."
  },
  all: {
    ...nullableSeconds,
    description: timer("Call time since the totals were last reset", "ZTIMER_ALL")
  },
  incoming: {
    ...nullableSeconds,
    description: timer("Incoming call time", "ZTIMER_INCOMING")
  },
  outgoing: {
    ...nullableSeconds,
    description: timer("Outgoing call time", "ZTIMER_OUTGOING")
  },
  last: {
    ...nullableSeconds,
    description: timer("The last call\u2019s time", "ZTIMER_LAST")
  },
  lifetime: {
    ...nullableSeconds,
    description: timer("Call time over the life of the store", "ZTIMER_LIFETIME")
  }
};
var CallTimersStream = class extends AppleCallHistoryStream {
  name = "callTimers";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "The call-time totals the Phone app keeps, one record for the store. Primary key id. Not narrowed by an import\u2019s date range: the totals span every call.",
    properties: properties2,
    required: Object.keys(properties2)
  };
  rows(scan) {
    return scan.timers;
  }
  records(timers) {
    return [{ ...timers }];
  }
};

// packages/sources/apple/call-history/dist/streams/calls-stream.js
var { id: id2, nullableText: nullableText2, nullableBoolean, nullableInteger, nullableSeconds: nullableSeconds2, nullableInstant } = callHistoryFields;
var stored = (what, column) => `${what} (ZCALLRECORD.${column}); NULL when callhistoryd stores none.`;
var code = (what, column) => `${what}: CallHistory's own code (ZCALLRECORD.${column}), whose values Apple does not document; NULL when none is stored.`;
var uuid2 = (what, column) => stored(`${what}, a UUID in uppercase`, column);
var properties3 = {
  id: {
    ...id2,
    description: "The call record\u2019s unique ID (ZCALLRECORD.ZUNIQUE_ID); the primary key. callParticipants.callId, emergencyMediaItems.callId and saintDavidsCounts.callId refer to it within this source. The same call has the same ID on every device that syncs call history through iCloud."
  },
  startedAt: {
    ...nullableInstant,
    description: "When the call started, in UTC to the microsecond (ZCALLRECORD.ZDATE, Core Data seconds since 2001-01-01 in a double); NULL when not recorded. An import\u2019s date range selects calls by it."
  },
  duration: {
    ...nullableSeconds2,
    description: stored("How long the call lasted, in seconds", "ZDURATION")
  },
  serviceProvider: {
    ...nullableText2,
    description: stored("The service that carried the call, such as com.apple.Telephony for a phone call or com.apple.FaceTime", "ZSERVICE_PROVIDER")
  },
  kind: {
    ...nullableText2,
    enum: ["phone", "faceTimeVideo", "faceTimeAudio"],
    description: "The kind of call: phone, faceTimeVideo or faceTimeAudio, from kindCode. NULL when kindCode is NULL or a code this reader does not know."
  },
  kindCode: {
    ...nullableInteger,
    description: "CallHistory\u2019s call type (ZCALLRECORD.ZCALLTYPE): 1 phone, 8 FaceTime video, 16 FaceTime audio. Kept as stored, so a type Apple adds later still loads."
  },
  category: {
    ...nullableText2,
    enum: ["audio", "video"],
    description: "Whether the call was audio or video, from categoryCode. NULL when categoryCode is NULL or a code this reader does not know, such as a TTY call."
  },
  categoryCode: {
    ...nullableInteger,
    description: "CallHistory\u2019s call category (ZCALLRECORD.ZCALL_CATEGORY): 1 audio, 2 video. Kept as stored."
  },
  outgoing: {
    ...nullableBoolean,
    description: stored("Whether this side placed the call; false for an incoming call", "ZORIGINATED")
  },
  answered: {
    ...nullableBoolean,
    description: stored("Whether the call was answered", "ZANSWERED")
  },
  read: {
    ...nullableBoolean,
    description: stored("Whether a missed call has been seen in Recents", "ZREAD")
  },
  hasMessage: {
    ...nullableBoolean,
    description: stored("Whether the caller left a message", "ZHASMESSAGE")
  },
  address: {
    ...nullableText2,
    description: stored("The other party\u2019s phone number or address as the call recorded it", "ZADDRESS")
  },
  name: {
    ...nullableText2,
    description: stored("The name the call showed for the other party", "ZNAME")
  },
  location: {
    ...nullableText2,
    description: stored("The place the number belongs to, such as a city or country", "ZLOCATION")
  },
  isoCountryCode: {
    ...nullableText2,
    description: stored("The ISO country code the number was read in", "ZISO_COUNTRY_CODE")
  },
  handleType: {
    ...nullableInteger,
    description: code("The kind of address", "ZHANDLE_TYPE")
  },
  initiatorType: {
    ...nullableInteger,
    description: "The handle type of the party who started the call (ZHANDLE.ZTYPE through ZCALLRECORD.ZINITIATOR), a code Apple does not document; NULL when the call names no initiator."
  },
  initiatorValue: {
    ...nullableText2,
    description: "The phone number or address of the party who started the call (ZHANDLE.ZVALUE through ZCALLRECORD.ZINITIATOR); NULL when the call names no initiator."
  },
  initiatorNormalizedValue: {
    ...nullableText2,
    description: "initiatorValue as CallHistory normalizes it for matching (ZHANDLE.ZNORMALIZEDVALUE); NULL when not stored."
  },
  numberAvailability: {
    ...nullableInteger,
    description: code("Whether the caller\u2019s number was available", "ZNUMBER_AVAILABILITY")
  },
  disconnectedCause: {
    ...nullableInteger,
    description: code("Why the call ended", "ZDISCONNECTED_CAUSE")
  },
  filteredOutReason: {
    ...nullableInteger,
    description: code("Why the call was filtered out of Recents", "ZFILTERED_OUT_REASON")
  },
  blockedByExtension: {
    ...nullableText2,
    description: stored("The bundle identifier of the call blocking extension that blocked the call", "ZBLOCKEDBYEXTENSION")
  },
  blockedByExtensionName: {
    ...nullableText2,
    description: stored("The name of that blocking extension", "ZBLOCKEDBYEXTENSIONNAME")
  },
  identityExtension: {
    ...nullableText2,
    description: stored("The bundle identifier of the caller ID extension that named the caller", "ZIDENTITYEXTENSION")
  },
  callDirectoryIdentityType: {
    ...nullableInteger,
    description: code("How a caller ID extension identified the caller", "ZCALLDIRECTORYIDENTITYTYPE")
  },
  junkConfidence: {
    ...nullableInteger,
    description: code("How likely the call is junk", "ZJUNKCONFIDENCE")
  },
  junkIdentificationCategory: {
    ...nullableText2,
    description: stored("The category under which the call was identified as junk", "ZJUNKIDENTIFICATIONCATEGORY")
  },
  verificationStatus: {
    ...nullableInteger,
    description: code("Whether the caller\u2019s number was verified", "ZVERIFICATIONSTATUS")
  },
  communicationTrustScore: {
    ...nullableInteger,
    description: code("How much the caller is trusted", "ZCOMMUNICATIONTRUSTSCORE")
  },
  autoAnsweredReason: {
    ...nullableInteger,
    description: code("Why the call was answered automatically", "ZAUTOANSWEREDREASON")
  },
  screenSharingType: {
    ...nullableInteger,
    description: code("Whether and how the screen was shared", "ZSCREENSHARINGTYPE")
  },
  originatingUIType: {
    ...nullableInteger,
    description: code("Where the call was started, such as the Messages avatar bar or a side button hold", "ZORIGINATINGUITYPE")
  },
  originatingDeviceName: {
    ...nullableText2,
    description: stored("The name of the device the call was made on", "ZORIGINATINGDEVICENAME")
  },
  faceTimeData: {
    ...nullableInteger,
    description: code("FaceTime data for the call, kept as stored", "ZFACE_TIME_DATA")
  },
  wasEmergencyCall: {
    ...nullableBoolean,
    description: stored("Whether the call was an emergency call", "ZWASEMERGENCYCALL")
  },
  usedEmergencyVideoStreaming: {
    ...nullableBoolean,
    description: stored("Whether video was streamed to emergency services", "ZUSEDEMERGENCYVIDEOSTREAMING")
  },
  didEnableTranslation: {
    ...nullableBoolean,
    description: stored("Whether live translation was turned on", "ZDIDENABLETRANSLATION")
  },
  neededSCAnnouncement: {
    ...nullableBoolean,
    description: stored("CallHistory\u2019s neededSCAnnouncement flag, kept as stored", "ZNEEDEDSCANNOUNCEMENT")
  },
  conversationId: {
    ...nullableText2,
    description: uuid2("The FaceTime conversation the call belonged to", "ZCONVERSATIONID")
  },
  localParticipantUuid: {
    ...nullableText2,
    description: uuid2("This device\u2019s participant in the conversation", "ZLOCALPARTICIPANTUUID")
  },
  outgoingLocalParticipantUuid: {
    ...nullableText2,
    description: uuid2("This device\u2019s participant when it placed the call", "ZOUTGOINGLOCALPARTICIPANTUUID")
  },
  participantGroupUuid: {
    ...nullableText2,
    description: uuid2("The group of participants in a group call", "ZPARTICIPANTGROUPUUID")
  },
  reminderUuid: {
    ...nullableText2,
    description: uuid2("The reminder set to return the call", "ZREMINDERUUID")
  },
  imageUrl: {
    ...nullableText2,
    description: stored("The image URL shown for the call", "ZIMAGEURL")
  },
  saintDavids1: {
    ...nullableInteger,
    description: code("CallHistory\u2019s saint_davids_1 value, an Apple feature it does not name", "ZSAINT_DAVIDS_1")
  },
  saintDavids2: {
    ...nullableText2,
    description: stored("CallHistory\u2019s saint_davids_2 value, an Apple feature it does not name", "ZSAINT_DAVIDS_2")
  }
};
var CallsStream = class extends AppleCallHistoryStream {
  name = "calls";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One record per call in this Mac's call history (~/Library/Application Support/CallHistoryDB/CallHistory.storedata): phone calls relayed from an iPhone or synced through iCloud, and FaceTime calls. Primary key id. Read from the CallHistory framework's Core Data store without Phone, FaceTime or the framework.",
    properties: properties3,
    required: Object.keys(properties3)
  };
  rows(scan) {
    return scan.calls;
  }
  records(call) {
    return [
      {
        id: call.id,
        startedAt: call.startedAt,
        duration: call.duration,
        serviceProvider: call.serviceProvider,
        kind: call.kind,
        kindCode: call.kindCode,
        category: call.category,
        categoryCode: call.categoryCode,
        outgoing: call.outgoing,
        answered: call.answered,
        read: call.read,
        hasMessage: call.hasMessage,
        address: call.address,
        name: call.name,
        location: call.location,
        isoCountryCode: call.isoCountryCode,
        handleType: call.handleType,
        initiatorType: call.initiator?.type ?? null,
        initiatorValue: call.initiator?.value ?? null,
        initiatorNormalizedValue: call.initiator?.normalizedValue ?? null,
        numberAvailability: call.numberAvailability,
        disconnectedCause: call.disconnectedCause,
        filteredOutReason: call.filteredOutReason,
        blockedByExtension: call.blockedByExtension,
        blockedByExtensionName: call.blockedByExtensionName,
        identityExtension: call.identityExtension,
        callDirectoryIdentityType: call.callDirectoryIdentityType,
        junkConfidence: call.junkConfidence,
        junkIdentificationCategory: call.junkIdentificationCategory,
        verificationStatus: call.verificationStatus,
        communicationTrustScore: call.communicationTrustScore,
        autoAnsweredReason: call.autoAnsweredReason,
        screenSharingType: call.screenSharingType,
        originatingUIType: call.originatingUIType,
        originatingDeviceName: call.originatingDeviceName,
        faceTimeData: call.faceTimeData,
        wasEmergencyCall: call.wasEmergencyCall,
        usedEmergencyVideoStreaming: call.usedEmergencyVideoStreaming,
        didEnableTranslation: call.didEnableTranslation,
        neededSCAnnouncement: call.neededSCAnnouncement,
        conversationId: call.conversationId,
        localParticipantUuid: call.localParticipantUuid,
        outgoingLocalParticipantUuid: call.outgoingLocalParticipantUuid,
        participantGroupUuid: call.participantGroupUuid,
        reminderUuid: call.reminderUuid,
        imageUrl: call.imageUrl,
        saintDavids1: call.saintDavids1,
        saintDavids2: call.saintDavids2
      }
    ];
  }
};

// packages/sources/apple/call-history/dist/streams/emergency-media-items-stream.js
var { integer: integer3, nullableId, nullableInteger: nullableInteger2, nullableText: nullableText3 } = callHistoryFields;
var properties4 = {
  id: {
    ...integer3,
    description: "The store\u2019s row number for the item (ZEMERGENCYMEDIAITEM.Z_PK); the primary key. Its call is optional in Apple\u2019s model, so no call-based key is guaranteed."
  },
  callId: {
    ...nullableId,
    description: "The call the media was uploaded for; refers to calls.id within this source. NULL when the item names no call."
  },
  mediaType: {
    ...nullableInteger2,
    description: "CallHistory\u2019s media type code (ZEMERGENCYMEDIAITEM.ZEMERGENCYMEDIATYPE), whose values Apple does not document; NULL when none is stored."
  },
  assetId: {
    ...nullableText3,
    description: "The uploaded media asset\u2019s identifier (ZEMERGENCYMEDIAITEM.ZASSETID); NULL when not stored."
  }
};
var EmergencyMediaItemsStream = class extends AppleCallHistoryStream {
  name = "emergencyMediaItems";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One record per photo or video shared with emergency services during an emergency call. Primary key id.",
    properties: properties4,
    required: Object.keys(properties4)
  };
  rows(scan) {
    return scan.emergencyMediaItems;
  }
  records(item) {
    return [{ ...item }];
  }
};

// packages/sources/apple/call-history/dist/streams/saint-davids-counts-stream.js
var { integer: integer4, nullableId: nullableId2, nullableInteger: nullableInteger3 } = callHistoryFields;
var properties5 = {
  id: {
    ...integer4,
    description: "The store\u2019s row number for the count (ZSAINTDAVIDSCOUNTS.Z_PK); the primary key. Its call is optional in Apple\u2019s model, so no call-based key is guaranteed."
  },
  callId: {
    ...nullableId2,
    description: "The call counted; refers to calls.id within this source. NULL when the count names no call."
  },
  type: {
    ...nullableInteger3,
    description: "The type code counted (ZSAINTDAVIDSCOUNTS.ZTYPE), whose values Apple does not document; NULL when none is stored."
  },
  count: {
    ...nullableInteger3,
    description: "The count (ZSAINTDAVIDSCOUNTS.ZCOUNT); NULL when none is stored."
  }
};
var SaintDavidsCountsStream = class extends AppleCallHistoryStream {
  name = "saintDavidsCounts";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One record per count CallHistory keeps for a call and type code, in its SaintDavidsCounts entity. Apple names neither the feature nor its codes, so values are kept as stored. Primary key id.",
    properties: properties5,
    required: Object.keys(properties5)
  };
  rows(scan) {
    return scan.saintDavidsCounts;
  }
  records(count) {
    return [{ ...count }];
  }
};

// packages/sources/apple/call-history/dist/apple-call-history-source.js
var readers = {
  calls: new CallsStream(),
  callParticipants: new CallParticipantsStream(),
  callTimers: new CallTimersStream(),
  emergencyMediaItems: new EmergencyMediaItemsStream(),
  saintDavidsCounts: new SaintDavidsCountsStream()
};
var catalog = new Catalog(Object.values(readers).map((reader) => reader.describe()));
var readersByName = new Map(Object.values(readers).map((reader) => [reader.name, reader]));
var pollIntervalMs = 1e3;
var AppleCallHistorySource = class extends Source {
  identity;
  catalog = catalog;
  calls = readers.calls.describe();
  callParticipants = readers.callParticipants.describe();
  callTimers = readers.callTimers.describe();
  emergencyMediaItems = readers.emergencyMediaItems.describe();
  saintDavidsCounts = readers.saintDavidsCounts.describe();
  path;
  scope;
  #store;
  constructor(path = callHistoryStorePath, scope = {}) {
    super();
    this.path = path;
    this.scope = scope;
    this.#store = new CallHistoryStore(path);
    this.identity = `apple-call-history:${path}`;
    Object.freeze(this);
  }
  async open() {
    return new CallHistoryScan(this.#store.open(), this.scope);
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
      yield streams;
      try {
        for await (const _2 of setInterval(pollIntervalMs, void 0, {
          signal
        })) {
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
      throw new Error(`Apple Call History has no stream ${stream.name}`);
    const records = reader.read(scan);
    yield* configuration.syncMode === "incremental" ? diffSnapshot(stream, records, state) : records.map((data) => ({ stream: stream.name, data }));
  }
};

// packages/connectors/apple/call-history/dist/call-history-connector.js
var CallHistoryConnector = class extends AppleConnector {
  datedBy = "call date";
  fullDiskAccess = true;
  // One small store of every call on this Mac; a date range is the only
  // narrowing.
  choices = [];
  // Reading the calls opens the protected call history store.
  probe = "calls";
  unscoped = [];
  storeCopies = [];
  access() {
    return "No app needs to be open: macOS keeps the calls from Phone, FaceTime and your iPhone in one store.";
  }
  source(scope) {
    return new AppleCallHistorySource(void 0, scope);
  }
};
export {
  CallHistoryConnector as default
};
