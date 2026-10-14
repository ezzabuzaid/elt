import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  ProtobufMessage
} from "../../chunks/chunk-T4P6QKHM.mjs";
import {
  selected,
  withinDates
} from "../../chunks/chunk-YM7ADF2O.mjs";
import {
  decodeArchive,
  isDictionary
} from "../../chunks/chunk-CWCLYXDX.mjs";
import {
  AppDatabase,
  AppDatabaseVersion,
  referenceDateInstant
} from "../../chunks/chunk-DV4S52G7.mjs";
import {
  AppleConnector
} from "../../chunks/chunk-4RDXSJJA.mjs";
import {
  Catalog,
  ClosedWorld,
  Retention,
  Source,
  Stream,
  diffSnapshot,
  validateRecords
} from "../../chunks/chunk-DK364VUN.mjs";
import {
  __callDispose,
  __using
} from "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/sources/whatsapp/desktop/dist/whatsapp-desktop-source.js
import { setInterval } from "node:timers/promises";

// packages/sdks/whatsapp/desktop/dist/errors.js
var WhatsAppUnavailableError = class extends Error {
  name = "WhatsAppUnavailableError";
  constructor(path, cause) {
    super(`The WhatsApp store at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security, and open WhatsApp once so it creates its stores.`, { cause });
  }
};
var WhatsAppSchemaError = class extends Error {
  name = "WhatsAppSchemaError";
  constructor(path, missing) {
    super(`The WhatsApp store at ${path} has a layout this reader does not read (missing ${missing.join(", ")}).`);
  }
};

// packages/sdks/whatsapp/desktop/dist/values.js
import { existsSync } from "node:fs";
function text(value) {
  return typeof value === "string" ? value : null;
}
function requiredText(value, missing) {
  if (typeof value !== "string" || value === "")
    throw new TypeError(missing);
  return value;
}
function number(value) {
  return value === null ? null : Number(value);
}
function requiredNumber(value, missing) {
  if (value === null)
    throw new TypeError(missing);
  return Number(value);
}
function flag(value) {
  return value === null ? null : Number(value) === 1;
}
function requiredFlag(value, missing) {
  const read = flag(value);
  if (read === null)
    throw new TypeError(missing);
  return read;
}
function bytes(value) {
  if (value === null)
    return null;
  if (!(value instanceof Uint8Array))
    throw new TypeError("A WhatsApp blob column holds no bytes");
  return value;
}
function instant(value) {
  return value === null ? null : referenceDateInstant(Number(value));
}
function unixSecondInstant(seconds) {
  return seconds === void 0 || seconds === null ? null : new Date(seconds * 1e3).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function onDisk(path) {
  return existsSync(path) ? path : null;
}

// packages/sdks/whatsapp/desktop/dist/businesses.js
var requiredColumns = {
  ZWABIZPROFILEDATA: [
    "Z_PK",
    "ZJID",
    "ZBUSINESSDESCRIPTION",
    "ZADDRESS",
    "ZLATITUDE",
    "ZLONGITUDE",
    "ZEMAIL",
    "ZWEBSITES",
    "ZHOURSCONFIGS",
    "ZTIMEZONE",
    "ZMEMBERSINCEDATE",
    "ZMEMBERSINCETEXT",
    "ZCUSTOMURL",
    "ZVERTICAL",
    "ZCANONICALVERTICAL",
    "ZPARENTCOMPANYNAME",
    "ZPARENTCOMPANYLOGOURL",
    "ZISAUTHORIZEDAGENT",
    "ZLINKEDACCOUNTS",
    "ZPROFILEOPTIONS",
    "ZBOTDATA",
    "ZCOVERPHOTO"
  ],
  ZWABIZPROFILEOPTIONSDATA: [
    "Z_PK",
    "ZCOMMERCEEXPERIENCE",
    "ZCARTENABLED",
    "ZSHOPURL",
    "ZISVIDEOCALLINGENABLED"
  ],
  ZWABIZBOTDATA: ["Z_PK", "ZAUTOMATEDTYPE"],
  ZWABIZCOVERPHOTODATA: ["Z_PK", "ZIMAGEID", "ZURL"],
  ZWABIZCATEGORYDATA: [
    "Z_PK",
    "ZPROFILE",
    "Z_FOK_PROFILE",
    "ZCATEGORYID",
    "ZNAME"
  ],
  ZWABIZSERVICEAREADATA: [
    "Z_PK",
    "ZPROFILE",
    "ZLATITUDE",
    "ZLONGITUDE",
    "ZAREARADIUSMETERS",
    "ZAREADESCRIPTION"
  ],
  ZWABIZBOTPROMPTDATA: ["Z_PK", "ZBOTDATA", "Z_FOK_BOTDATA", "ZTEXT", "ZEMOJI"],
  ZWABIZVERIFIEDNAMEDATA: [
    "Z_PK",
    "ZJID",
    "ZPHONENUMBERJID",
    "ZNAME",
    "ZVERIFICATIONLEVEL",
    "ZEXPIRES",
    "ZCERTIFICATEDETAILS"
  ],
  ZWABIZROLEDATA: ["Z_PK", "ZJID", "ZACTOR", "ZHOSTSTORAGE", "ZLASTUPDATETIME"]
};
function archived(value) {
  const archive = bytes(value);
  return archive === null ? null : decodeArchive(archive);
}
function archivedProtobuf(value) {
  const decoded = archived(value);
  if (decoded === null)
    return null;
  if (!isDictionary(decoded))
    throw new TypeError("A WhatsApp business blob holds no protobuf message");
  const { GPBData } = decoded;
  return new ProtobufMessage(GPBData === void 0 ? new Uint8Array() : bytes(GPBData) ?? new Uint8Array());
}
var BusinessesSnapshot = class {
  #database;
  constructor(path) {
    this.#database = new AppDatabase(path, WhatsAppUnavailableError);
    this.#database.requireColumns(requiredColumns, WhatsAppSchemaError);
  }
  profiles() {
    return this.#database.all(`SELECT profile.ZJID AS jid,
                profile.ZBUSINESSDESCRIPTION AS description,
                profile.ZADDRESS AS address, profile.ZLATITUDE AS latitude,
                profile.ZLONGITUDE AS longitude, profile.ZEMAIL AS email,
                profile.ZWEBSITES AS websites, profile.ZTIMEZONE AS timezone,
                profile.ZMEMBERSINCEDATE AS memberSinceDate,
                profile.ZMEMBERSINCETEXT AS memberSinceText,
                profile.ZCUSTOMURL AS customUrl, profile.ZVERTICAL AS vertical,
                profile.ZCANONICALVERTICAL AS canonicalVertical,
                profile.ZPARENTCOMPANYNAME AS parentCompanyName,
                profile.ZPARENTCOMPANYLOGOURL AS parentCompanyLogoUrl,
                profile.ZISAUTHORIZEDAGENT AS isAuthorizedAgent,
                profile.ZLINKEDACCOUNTS AS linkedAccounts,
                options.ZCOMMERCEEXPERIENCE AS commerceExperience,
                options.ZCARTENABLED AS cartEnabled,
                options.ZSHOPURL AS shopUrl,
                options.ZISVIDEOCALLINGENABLED AS isVideoCallingEnabled,
                bot.ZAUTOMATEDTYPE AS automatedType,
                cover.ZIMAGEID AS coverPhotoId, cover.ZURL AS coverPhotoUrl
         FROM ZWABIZPROFILEDATA AS profile
         LEFT JOIN ZWABIZPROFILEOPTIONSDATA AS options
           ON options.Z_PK = profile.ZPROFILEOPTIONS
         LEFT JOIN ZWABIZBOTDATA AS bot ON bot.Z_PK = profile.ZBOTDATA
         LEFT JOIN ZWABIZCOVERPHOTODATA AS cover
           ON cover.Z_PK = profile.ZCOVERPHOTO
         ORDER BY profile.Z_PK`).map((row) => {
      const linked = archivedProtobuf(row.linkedAccounts);
      const facebook = linked?.message(1);
      const instagram = linked?.message(2);
      return {
        jid: requiredText(row.jid, "A WhatsApp business has no JID"),
        description: text(row.description),
        address: text(row.address),
        latitude: number(row.latitude),
        longitude: number(row.longitude),
        email: text(row.email),
        websites: websites(row.websites),
        timezone: text(row.timezone),
        memberSinceDate: instant(row.memberSinceDate),
        memberSinceText: text(row.memberSinceText),
        customUrl: text(row.customUrl),
        vertical: text(row.vertical),
        canonicalVertical: text(row.canonicalVertical),
        parentCompanyName: text(row.parentCompanyName),
        parentCompanyLogoUrl: text(row.parentCompanyLogoUrl),
        isAuthorizedAgent: flag(row.isAuthorizedAgent),
        commerceExperience: text(row.commerceExperience),
        cartEnabled: flag(row.cartEnabled),
        shopUrl: text(row.shopUrl),
        isVideoCallingEnabled: flag(row.isVideoCallingEnabled),
        automatedType: text(row.automatedType),
        coverPhotoId: text(row.coverPhotoId),
        coverPhotoUrl: text(row.coverPhotoUrl),
        facebookPageId: facebook?.string(1) ?? null,
        facebookPageName: facebook?.string(2) ?? null,
        facebookLikes: facebook?.uint(3) ?? null,
        instagramHandle: instagram?.string(1) ?? null,
        instagramFollowers: instagram?.uint(2) ?? null
      };
    });
  }
  verifiedNames() {
    return this.#database.all(`SELECT name.ZJID AS lid, name.ZPHONENUMBERJID AS phoneNumberJid,
                name.ZNAME AS name,
                name.ZVERIFICATIONLEVEL AS verificationLevel,
                name.ZEXPIRES AS expires,
                name.ZCERTIFICATEDETAILS AS certificate,
                role.ZACTOR AS roleActor, role.ZHOSTSTORAGE AS roleHostStorage,
                role.ZLASTUPDATETIME AS roleUpdatedAt
         FROM ZWABIZVERIFIEDNAMEDATA AS name
         LEFT JOIN ZWABIZROLEDATA AS role ON role.ZJID = name.ZJID
         ORDER BY name.Z_PK`).map((row) => {
      const certificate = archivedProtobuf(row.certificate);
      return {
        lid: requiredText(row.lid, "A WhatsApp verified name has no LID"),
        phoneNumberJid: text(row.phoneNumberJid),
        name: text(row.name),
        verificationLevel: number(row.verificationLevel),
        expires: instant(row.expires),
        certificateSerial: certificate?.uint64(1)?.toString() ?? null,
        certificateIssuer: certificate?.string(2) ?? null,
        certificateIssuedAt: unixSecondInstant(certificate?.uint(10)),
        roleActor: number(row.roleActor),
        roleHostStorage: number(row.roleHostStorage),
        roleUpdatedAt: unixSecondInstant(number(row.roleUpdatedAt))
      };
    });
  }
  categories() {
    return this.#database.all(`SELECT profile.ZJID AS jid, category.ZCATEGORYID AS categoryId,
                category.ZNAME AS name
         FROM ZWABIZCATEGORYDATA AS category
         JOIN ZWABIZPROFILEDATA AS profile ON profile.Z_PK = category.ZPROFILE
         ORDER BY profile.Z_PK, category.Z_FOK_PROFILE, category.Z_PK`).map((row, index, rows) => ({
      jid: requiredText(row.jid, "A WhatsApp business has no JID"),
      position: position(rows, index),
      categoryId: requiredText(row.categoryId, "A WhatsApp business category has no ID"),
      name: text(row.name)
    }));
  }
  hours() {
    return this.#database.all(`SELECT ZJID AS jid, ZHOURSCONFIGS AS hours FROM ZWABIZPROFILEDATA
         WHERE ZHOURSCONFIGS IS NOT NULL ORDER BY Z_PK`).flatMap((row) => {
      const jid23 = requiredText(row.jid, "A WhatsApp business has no JID");
      const configs = archived(row.hours);
      if (!Array.isArray(configs))
        throw new TypeError("WhatsApp business hours are not a list");
      return configs.map((config) => {
        if (!isDictionary(config))
          throw new TypeError("WhatsApp business hours are not a list");
        const { day, mode, openTime, closeTime } = config;
        if (typeof day !== "number" || typeof mode !== "number" || typeof openTime !== "number" || typeof closeTime !== "number")
          throw new TypeError("WhatsApp business hours lack a field");
        return { jid: jid23, day, mode, openTime, closeTime };
      });
    });
  }
  serviceAreas() {
    return this.#database.all(`SELECT profile.ZJID AS jid, area.ZLATITUDE AS latitude,
                area.ZLONGITUDE AS longitude,
                area.ZAREARADIUSMETERS AS radiusMeters,
                area.ZAREADESCRIPTION AS description
         FROM ZWABIZSERVICEAREADATA AS area
         JOIN ZWABIZPROFILEDATA AS profile ON profile.Z_PK = area.ZPROFILE
         ORDER BY profile.Z_PK, area.Z_PK`).map((row, index, rows) => ({
      jid: requiredText(row.jid, "A WhatsApp business has no JID"),
      position: position(rows, index),
      latitude: number(row.latitude),
      longitude: number(row.longitude),
      radiusMeters: number(row.radiusMeters),
      description: text(row.description)
    }));
  }
  botPrompts() {
    return this.#database.all(`SELECT profile.ZJID AS jid, prompt.ZTEXT AS text,
                prompt.ZEMOJI AS emoji
         FROM ZWABIZBOTPROMPTDATA AS prompt
         JOIN ZWABIZPROFILEDATA AS profile ON profile.ZBOTDATA = prompt.ZBOTDATA
         ORDER BY profile.Z_PK, prompt.Z_FOK_BOTDATA, prompt.Z_PK`).map((row, index, rows) => ({
      jid: requiredText(row.jid, "A WhatsApp business has no JID"),
      position: position(rows, index),
      text: requiredText(row.text, "A WhatsApp business prompt has no text"),
      emoji: text(row.emoji)
    }));
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
};
function websites(value) {
  const decoded = archived(value);
  if (decoded === null)
    return [];
  if (!Array.isArray(decoded) || !decoded.every((url) => typeof url === "string"))
    throw new TypeError("WhatsApp business websites are not a list of text");
  return decoded;
}
function position(rows, index) {
  let first = index;
  while (first > 0 && rows[first - 1]?.jid === rows[index]?.jid)
    first -= 1;
  return index - first;
}

// packages/sdks/whatsapp/desktop/dist/calls.js
var requiredColumns2 = {
  ZWACDCALLEVENT: [
    "Z_PK",
    "ZCALLIDSTRING",
    "ZDATE",
    "ZDURATION",
    "ZOUTCOME",
    "ZBYTESSENT",
    "ZBYTESRECEIVED",
    "ZGROUPJIDSTRING",
    "ZGROUPCALLCREATORUSERJIDSTRING",
    "ZISBOTGROUPCALL",
    "ZISLIGHTWEIGHT",
    "ZREMINDERID",
    "ZSCHEDULEDID"
  ],
  ZWAAGGREGATECALLEVENT: [
    "Z_PK",
    "ZINCOMING",
    "ZMISSED",
    "ZMISSEDREASON",
    "ZVIDEO",
    "ZFIRSTDATE",
    "ZLINKTOKEN"
  ],
  ZWACDCALLEVENTPARTICIPANT: ["Z_PK", "ZJIDSTRING", "ZOUTCOME"]
};
var CallsSnapshot = class {
  #database;
  #callLog;
  #participantLog;
  constructor(path) {
    this.#database = new AppDatabase(path, WhatsAppUnavailableError);
    this.#database.requireColumns(requiredColumns2, WhatsAppSchemaError);
    try {
      this.#callLog = this.#relationship("ZWACDCALLEVENT", "CALLEVENTS");
      this.#participantLog = this.#relationship("ZWACDCALLEVENTPARTICIPANT", "PARTICIPANTS");
    } catch (error) {
      this.#database[Symbol.dispose]();
      throw error;
    }
  }
  calls() {
    return this.#database.all(`SELECT call.ZCALLIDSTRING AS callId, call.ZDATE AS date,
                call.ZDURATION AS duration, call.ZOUTCOME AS outcome,
                call.ZBYTESSENT AS bytesSent,
                call.ZBYTESRECEIVED AS bytesReceived,
                call.ZGROUPJIDSTRING AS groupJid,
                call.ZGROUPCALLCREATORUSERJIDSTRING AS groupCallCreatorJid,
                call.ZISBOTGROUPCALL AS isBotGroupCall,
                call.ZISLIGHTWEIGHT AS isLightweight,
                call.ZREMINDERID AS reminderId,
                call.ZSCHEDULEDID AS scheduledId, log.ZINCOMING AS incoming,
                log.ZMISSED AS missed, log.ZMISSEDREASON AS missedReason,
                log.ZVIDEO AS video, log.ZFIRSTDATE AS firstDate,
                log.ZLINKTOKEN AS linkToken
         FROM ZWACDCALLEVENT AS call
         LEFT JOIN ZWAAGGREGATECALLEVENT AS log
           ON log.Z_PK = call."${this.#callLog}"
         ORDER BY call.Z_PK`).map((row) => ({
      callId: requiredText(row.callId, "A WhatsApp call has no ID"),
      date: instant(row.date),
      duration: number(row.duration),
      outcome: number(row.outcome),
      bytesSent: number(row.bytesSent),
      bytesReceived: number(row.bytesReceived),
      groupJid: text(row.groupJid),
      groupCallCreatorJid: text(row.groupCallCreatorJid),
      isBotGroupCall: flag(row.isBotGroupCall),
      isLightweight: flag(row.isLightweight),
      reminderId: text(row.reminderId),
      scheduledId: text(row.scheduledId),
      incoming: flag(row.incoming),
      missed: flag(row.missed),
      missedReason: number(row.missedReason),
      video: flag(row.video),
      firstDate: instant(row.firstDate),
      linkToken: text(row.linkToken)
    }));
  }
  participants() {
    return this.#database.all(`SELECT call.ZCALLIDSTRING AS callId, participant.ZJIDSTRING AS jid,
                participant.ZOUTCOME AS outcome
         FROM ZWACDCALLEVENTPARTICIPANT AS participant
         JOIN ZWACDCALLEVENT AS call
           ON call."${this.#callLog}" = participant."${this.#participantLog}"
         ORDER BY participant.Z_PK, call.Z_PK`).map((row) => ({
      callId: requiredText(row.callId, "A WhatsApp call has no ID"),
      jid: requiredText(row.jid, "A WhatsApp call participant has no JID"),
      outcome: number(row.outcome)
    }));
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
  // The call-log entry's calls and participants are to-many relationships
  // with no inverse, which Core Data keeps as a column on each call and
  // participant named after the entry's entity number and the relationship
  // (Z1CALLEVENTS, Z1PARTICIPANTS). The number changes between model
  // versions, so the column is found by the end of its name; Z_FOK_ columns
  // only order the relationship.
  #relationship(table, name) {
    const found = this.#database.all("SELECT name FROM pragma_table_info(?)", table).map((column6) => String(column6.name)).filter((column6) => /^Z\d+/.test(column6) && column6.endsWith(name));
    const [column5] = found;
    if (column5 === void 0 || found.length !== 1)
      throw new WhatsAppSchemaError(this.#database.path, [
        `${table}.Z*${name}`
      ]);
    return column5;
  }
};

// packages/sdks/whatsapp/desktop/dist/chat-storage.js
import { join } from "node:path";

// packages/sdks/whatsapp/desktop/dist/message-metadata.js
function quotedMessage(metadata) {
  const message = new ProtobufMessage(metadata);
  const stanzaId = message.string(5);
  if (stanzaId === void 0)
    return null;
  return { stanzaId, senderJid: message.string(6) ?? null };
}

// packages/sdks/whatsapp/desktop/dist/chat-storage.js
var requiredColumns3 = {
  ZWACHATSESSION: [
    "Z_PK",
    "ZCONTACTJID",
    "ZSESSIONTYPE",
    "ZPARTNERNAME",
    "ZCONTACTIDENTIFIER",
    "ZCONTACTABID",
    "ZARCHIVED",
    "ZHIDDEN",
    "ZREMOVED",
    "ZFLAGS",
    "ZUNREADCOUNT",
    "ZMESSAGECOUNTER",
    "ZIDENTITYVERIFICATIONSTATE",
    "ZIDENTITYVERIFICATIONEPOCH",
    "ZLASTMESSAGEDATE",
    "ZLASTMESSAGETEXT",
    "ZLOCATIONSHARINGENDDATE",
    "ZSAVEDINPUT",
    "ZGROUPINFO"
  ],
  ZWAGROUPINFO: [
    "Z_PK",
    "ZCREATIONDATE",
    "ZCREATORJID",
    "ZOWNERJID",
    "ZSUBJECTTIMESTAMP",
    "ZSUBJECTOWNERJID",
    "ZPICTUREID",
    "ZPICTUREPATH",
    "ZSOURCEJID",
    "ZSTATE"
  ],
  ZWAMESSAGE: [
    "Z_PK",
    "ZCHATSESSION",
    "ZISFROMME",
    "ZSTANZAID",
    "ZFROMJID",
    "ZTOJID",
    "ZGROUPMEMBER",
    "ZPUSHNAME",
    "ZMESSAGEDATE",
    "ZSENTDATE",
    "ZMESSAGETYPE",
    "ZGROUPEVENTTYPE",
    "ZMESSAGESTATUS",
    "ZMESSAGEERRORSTATUS",
    "ZFLAGS",
    "ZSTARRED",
    "ZSORT",
    "ZTEXT",
    "ZCHILDMESSAGESDELIVEREDCOUNT",
    "ZCHILDMESSAGESREADCOUNT",
    "ZCHILDMESSAGESPLAYEDCOUNT",
    "ZFILTEREDRECIPIENTCOUNT",
    "ZPARENTMESSAGE",
    "ZMEDIAITEM",
    "ZMESSAGEINFO"
  ],
  ZWAMEDIAITEM: [
    "Z_PK",
    "ZMEDIALOCALPATH",
    "ZTHUMBNAILLOCALPATH",
    "ZMEDIAURL",
    "ZMEDIAURLDATE",
    "ZFILESIZE",
    "ZMOVIEDURATION",
    "ZASPECTRATIO",
    "ZTITLE",
    "ZAUTHORNAME",
    "ZCOLLECTIONNAME",
    "ZVCARDNAME",
    "ZVCARDSTRING",
    "ZLATITUDE",
    "ZLONGITUDE",
    "ZHACCURACY",
    "ZMEDIAORIGIN",
    "ZCLOUDSTATUS",
    "ZMETADATA"
  ],
  ZWAMESSAGEINFO: ["Z_PK", "ZRECEIPTINFO"],
  ZWAMESSAGEDATAITEM: [
    "ZMESSAGE",
    "ZINDEX",
    "ZTYPE",
    "ZDATE",
    "ZCONTENT1",
    "ZCONTENT2",
    "ZTITLE",
    "ZSUMMARY",
    "ZMATCHEDTEXT",
    "ZSECTIONID",
    "ZSENDERJID",
    "ZTHUMBNAILPATH",
    "ZOWNSTHUMBNAIL"
  ],
  ZWAGROUPMEMBER: [
    "Z_PK",
    "ZCHATSESSION",
    "ZMEMBERJID",
    "ZCONTACTNAME",
    "ZFIRSTNAME",
    "ZCONTACTIDENTIFIER",
    "ZCONTACTABID",
    "ZISACTIVE",
    "ZISADMIN"
  ],
  ZWAGROUPMEMBERSCHANGE: [
    "Z_PK",
    "ZGROUPJID",
    "ZCHANGEDATE",
    "ZCHANGETYPE",
    "ZMEMBERJIDS"
  ],
  ZWAPROFILEPUSHNAME: ["Z_PK", "ZJID", "ZPUSHNAME"],
  ZWAPROFILEPICTUREITEM: [
    "Z_PK",
    "ZJID",
    "ZPICTUREID",
    "ZPATH",
    "ZREQUESTDATE"
  ],
  ZWABLACKLISTITEM: ["Z_PK", "ZJID"],
  ZWACHATPUSHCONFIG: [
    "Z_PK",
    "ZJID",
    "ZALERTS",
    "ZMUTEDUNTIL",
    "ZSOUND",
    "ZRINGTONE"
  ]
};
function messageMediaFile(container, mediaLocalPath) {
  return join(container, "Message", mediaLocalPath);
}
function profilePictureFile(container, path) {
  return join(container, `${path}.thumb`);
}
var messageKey = `chat.ZCONTACTJID AS chatJid, message.ZISFROMME AS isFromMe,
  message.ZSTANZAID AS stanzaId`;
var ChatStorageSnapshot = class {
  #database;
  #container;
  constructor(path, container) {
    this.#database = new AppDatabase(path, WhatsAppUnavailableError);
    this.#database.requireColumns(requiredColumns3, WhatsAppSchemaError);
    this.#container = container;
  }
  chats() {
    return this.#database.all(`SELECT chat.ZCONTACTJID AS jid, chat.ZSESSIONTYPE AS sessionType,
                chat.ZPARTNERNAME AS partnerName,
                chat.ZCONTACTIDENTIFIER AS contactIdentifier,
                chat.ZCONTACTABID AS contactAbId, chat.ZARCHIVED AS archived,
                chat.ZHIDDEN AS hidden, chat.ZREMOVED AS removed,
                chat.ZFLAGS AS flags, chat.ZUNREADCOUNT AS unreadCount,
                chat.ZMESSAGECOUNTER AS messageCounter,
                chat.ZIDENTITYVERIFICATIONSTATE AS identityVerificationState,
                chat.ZIDENTITYVERIFICATIONEPOCH AS identityVerificationEpoch,
                chat.ZLASTMESSAGEDATE AS lastMessageDate,
                chat.ZLASTMESSAGETEXT AS lastMessageText,
                chat.ZLOCATIONSHARINGENDDATE AS locationSharingEndDate,
                chat.ZSAVEDINPUT AS savedInput, grp.Z_PK AS groupId,
                grp.ZCREATIONDATE AS creationDate,
                grp.ZCREATORJID AS creatorJid, grp.ZOWNERJID AS ownerJid,
                grp.ZSUBJECTTIMESTAMP AS subjectTimestamp,
                grp.ZSUBJECTOWNERJID AS subjectOwnerJid,
                grp.ZPICTUREID AS pictureId, grp.ZPICTUREPATH AS picturePath,
                grp.ZSOURCEJID AS sourceJid, grp.ZSTATE AS state
         FROM ZWACHATSESSION AS chat
         LEFT JOIN ZWAGROUPINFO AS grp ON grp.Z_PK = chat.ZGROUPINFO
         ORDER BY chat.Z_PK`).map((row) => ({
      jid: requiredText(row.jid, "A WhatsApp chat has no JID"),
      sessionType: requiredNumber(row.sessionType, "A WhatsApp chat has no session type"),
      partnerName: text(row.partnerName),
      contactIdentifier: text(row.contactIdentifier),
      contactAbId: number(row.contactAbId),
      archived: flag(row.archived),
      hidden: flag(row.hidden),
      removed: flag(row.removed),
      flags: number(row.flags),
      unreadCount: number(row.unreadCount),
      messageCounter: number(row.messageCounter),
      identityVerificationState: number(row.identityVerificationState),
      identityVerificationEpoch: number(row.identityVerificationEpoch),
      lastMessageDate: instant(row.lastMessageDate),
      lastMessageText: text(row.lastMessageText),
      locationSharingEndDate: instant(row.locationSharingEndDate),
      savedInput: text(row.savedInput),
      group: row.groupId === null ? null : {
        creationDate: instant(row.creationDate),
        creatorJid: text(row.creatorJid),
        ownerJid: text(row.ownerJid),
        subjectTimestamp: instant(row.subjectTimestamp),
        subjectOwnerJid: text(row.subjectOwnerJid),
        pictureId: text(row.pictureId),
        picturePath: text(row.picturePath),
        sourceJid: text(row.sourceJid),
        state: number(row.state)
      }
    }));
  }
  messages() {
    return this.#database.all(`SELECT ${messageKey}, message.ZFROMJID AS fromJid,
                message.ZTOJID AS toJid, member.ZMEMBERJID AS groupMemberJid,
                message.ZPUSHNAME AS pushName,
                message.ZMESSAGEDATE AS messageDate,
                message.ZSENTDATE AS sentDate,
                message.ZMESSAGETYPE AS messageType,
                message.ZGROUPEVENTTYPE AS groupEventType,
                message.ZMESSAGESTATUS AS messageStatus,
                message.ZMESSAGEERRORSTATUS AS messageErrorStatus,
                message.ZFLAGS AS flags, message.ZSTARRED AS starred,
                message.ZSORT AS sort, message.ZTEXT AS text,
                message.ZCHILDMESSAGESDELIVEREDCOUNT AS childMessagesDeliveredCount,
                message.ZCHILDMESSAGESREADCOUNT AS childMessagesReadCount,
                message.ZCHILDMESSAGESPLAYEDCOUNT AS childMessagesPlayedCount,
                message.ZFILTEREDRECIPIENTCOUNT AS filteredRecipientCount,
                parent.ZSTANZAID AS parentStanzaId, media.Z_PK AS mediaId,
                media.ZMEDIALOCALPATH AS mediaLocalPath,
                media.ZTHUMBNAILLOCALPATH AS thumbnailLocalPath,
                media.ZMEDIAURL AS mediaUrl,
                media.ZMEDIAURLDATE AS mediaUrlDate,
                media.ZFILESIZE AS fileSize,
                media.ZMOVIEDURATION AS movieDuration,
                media.ZASPECTRATIO AS aspectRatio, media.ZTITLE AS title,
                media.ZAUTHORNAME AS authorName,
                media.ZCOLLECTIONNAME AS collectionName,
                media.ZVCARDNAME AS vCardName,
                media.ZVCARDSTRING AS vCardString,
                media.ZLATITUDE AS latitude, media.ZLONGITUDE AS longitude,
                media.ZHACCURACY AS hAccuracy,
                media.ZMEDIAORIGIN AS mediaOrigin,
                media.ZCLOUDSTATUS AS cloudStatus,
                media.ZMETADATA AS metadata, info.ZRECEIPTINFO AS receiptInfo
         FROM ZWAMESSAGE AS message
         JOIN ZWACHATSESSION AS chat ON chat.Z_PK = message.ZCHATSESSION
         LEFT JOIN ZWAGROUPMEMBER AS member ON member.Z_PK = message.ZGROUPMEMBER
         LEFT JOIN ZWAMESSAGE AS parent ON parent.Z_PK = message.ZPARENTMESSAGE
         LEFT JOIN ZWAMEDIAITEM AS media ON media.Z_PK = message.ZMEDIAITEM
         LEFT JOIN ZWAMESSAGEINFO AS info ON info.Z_PK = message.ZMESSAGEINFO
         ORDER BY message.Z_PK`).map((row) => {
      const metadata = bytes(row.metadata);
      return {
        ...key(row),
        fromJid: text(row.fromJid),
        toJid: text(row.toJid),
        groupMemberJid: text(row.groupMemberJid),
        pushName: text(row.pushName),
        messageDate: instant(row.messageDate),
        sentDate: instant(row.sentDate),
        messageType: requiredNumber(row.messageType, "A WhatsApp message has no type"),
        groupEventType: number(row.groupEventType),
        messageStatus: number(row.messageStatus),
        messageErrorStatus: number(row.messageErrorStatus),
        flags: number(row.flags),
        starred: flag(row.starred),
        sort: number(row.sort),
        text: text(row.text),
        childMessagesDeliveredCount: number(row.childMessagesDeliveredCount),
        childMessagesReadCount: number(row.childMessagesReadCount),
        childMessagesPlayedCount: number(row.childMessagesPlayedCount),
        filteredRecipientCount: number(row.filteredRecipientCount),
        parentStanzaId: text(row.parentStanzaId),
        media: row.mediaId === null ? null : this.#media(row, metadata),
        quoted: metadata === null ? null : quotedMessage(metadata),
        receiptInfo: bytes(row.receiptInfo)
      };
    });
  }
  dataItems() {
    return this.#database.all(`SELECT ${messageKey}, item.ZINDEX AS "index", item.ZTYPE AS type,
                item.ZDATE AS date, item.ZCONTENT1 AS content1,
                item.ZCONTENT2 AS content2, item.ZTITLE AS title,
                item.ZSUMMARY AS summary, item.ZMATCHEDTEXT AS matchedText,
                item.ZSECTIONID AS sectionId, item.ZSENDERJID AS senderJid,
                item.ZTHUMBNAILPATH AS thumbnailPath,
                item.ZOWNSTHUMBNAIL AS ownsThumbnail
         FROM ZWAMESSAGEDATAITEM AS item
         JOIN ZWAMESSAGE AS message ON message.Z_PK = item.ZMESSAGE
         JOIN ZWACHATSESSION AS chat ON chat.Z_PK = message.ZCHATSESSION
         ORDER BY message.Z_PK, item.ZINDEX`).map((row) => ({
      ...key(row),
      index: requiredNumber(row.index, "A WhatsApp data item has no index"),
      type: number(row.type),
      date: instant(row.date),
      content1: text(row.content1),
      content2: text(row.content2),
      title: text(row.title),
      summary: text(row.summary),
      matchedText: text(row.matchedText),
      sectionId: text(row.sectionId),
      senderJid: text(row.senderJid),
      thumbnailPath: text(row.thumbnailPath),
      ownsThumbnail: flag(row.ownsThumbnail)
    }));
  }
  groupMembers() {
    return this.#database.all(`SELECT chat.ZCONTACTJID AS groupJid, member.ZMEMBERJID AS memberJid,
                member.ZCONTACTNAME AS contactName,
                member.ZFIRSTNAME AS firstName,
                member.ZCONTACTIDENTIFIER AS contactIdentifier,
                member.ZCONTACTABID AS contactAbId,
                member.ZISACTIVE AS isActive, member.ZISADMIN AS isAdmin
         FROM ZWAGROUPMEMBER AS member
         JOIN ZWACHATSESSION AS chat ON chat.Z_PK = member.ZCHATSESSION
         ORDER BY member.Z_PK`).map((row) => ({
      groupJid: requiredText(row.groupJid, "A WhatsApp group has no JID"),
      memberJid: requiredText(row.memberJid, "A WhatsApp group member has no JID"),
      contactName: text(row.contactName),
      firstName: text(row.firstName),
      contactIdentifier: text(row.contactIdentifier),
      contactAbId: number(row.contactAbId),
      isActive: flag(row.isActive),
      isAdmin: flag(row.isAdmin)
    }));
  }
  groupMembersChanges() {
    return this.#database.all(`SELECT ZGROUPJID AS groupJid, ZCHANGEDATE AS changeDate,
                ZCHANGETYPE AS changeType, ZMEMBERJIDS AS memberJids
         FROM ZWAGROUPMEMBERSCHANGE ORDER BY Z_PK`).map((row) => {
      const changeDate = instant(row.changeDate);
      if (changeDate === null)
        throw new TypeError("A WhatsApp group change has no date");
      return {
        groupJid: requiredText(row.groupJid, "A WhatsApp group has no JID"),
        changeDate,
        changeType: requiredNumber(row.changeType, "A WhatsApp group change has no type"),
        memberJids: requiredText(row.memberJids, "A WhatsApp group change names no member")
      };
    });
  }
  pushNames() {
    return this.#database.all("SELECT ZJID AS jid, ZPUSHNAME AS pushName FROM ZWAPROFILEPUSHNAME ORDER BY Z_PK").map((row) => ({
      jid: requiredText(row.jid, "A WhatsApp push name has no JID"),
      pushName: text(row.pushName)
    }));
  }
  profilePictures() {
    return this.#database.all(`SELECT ZJID AS jid, ZPICTUREID AS pictureId, ZPATH AS path,
                ZREQUESTDATE AS requestDate
         FROM ZWAPROFILEPICTUREITEM ORDER BY Z_PK`).map((row) => {
      const path = text(row.path);
      return {
        jid: requiredText(row.jid, "A WhatsApp profile picture has no JID"),
        pictureId: text(row.pictureId),
        path,
        file: path === null ? null : onDisk(profilePictureFile(this.#container, path)),
        requestDate: instant(row.requestDate)
      };
    });
  }
  blockedJids() {
    return this.#database.all("SELECT ZJID AS jid FROM ZWABLACKLISTITEM ORDER BY Z_PK").map((row) => requiredText(row.jid, "A blocked WhatsApp contact has no JID"));
  }
  chatPushConfigs() {
    return this.#database.all(`SELECT ZJID AS jid, ZALERTS AS alerts, ZMUTEDUNTIL AS mutedUntil,
                ZSOUND AS sound, ZRINGTONE AS ringtone
         FROM ZWACHATPUSHCONFIG ORDER BY Z_PK`).map((row) => ({
      jid: requiredText(row.jid, "A WhatsApp chat setting has no JID"),
      alerts: number(row.alerts),
      mutedUntil: instant(row.mutedUntil),
      sound: text(row.sound),
      ringtone: text(row.ringtone)
    }));
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
  #media(row, metadata) {
    const mediaLocalPath = text(row.mediaLocalPath);
    return {
      mediaLocalPath,
      mediaFile: mediaLocalPath === null ? null : onDisk(messageMediaFile(this.#container, mediaLocalPath)),
      thumbnailLocalPath: text(row.thumbnailLocalPath),
      mediaUrl: text(row.mediaUrl),
      mediaUrlDate: instant(row.mediaUrlDate),
      fileSize: number(row.fileSize),
      movieDuration: number(row.movieDuration),
      aspectRatio: number(row.aspectRatio),
      title: text(row.title),
      authorName: text(row.authorName),
      collectionName: text(row.collectionName),
      vCardName: text(row.vCardName),
      vCardString: text(row.vCardString),
      latitude: number(row.latitude),
      longitude: number(row.longitude),
      hAccuracy: number(row.hAccuracy),
      mediaOrigin: number(row.mediaOrigin),
      cloudStatus: number(row.cloudStatus),
      metadata
    };
  }
};
function key(row) {
  return {
    chatJid: requiredText(row.chatJid, "A WhatsApp chat has no JID"),
    isFromMe: requiredFlag(row.isFromMe, "A WhatsApp message has no sender side"),
    stanzaId: requiredText(row.stanzaId, "A WhatsApp message has no stanza ID")
  };
}

// packages/sdks/whatsapp/desktop/dist/contacts.js
var requiredColumns4 = {
  ZWAADDRESSBOOKCONTACT: [
    "Z_PK",
    "ZUNIQUEID",
    "ZWHATSAPPID",
    "ZLID",
    "ZINTEROPJID",
    "ZIDENTIFIER",
    "ZFULLNAME",
    "ZGIVENNAME",
    "ZLASTNAME",
    "ZBUSINESSNAME",
    "ZHIGHLIGHTEDNAME",
    "ZUSERNAME",
    "ZPHONENUMBER",
    "ZLOCALIZEDPHONENUMBER",
    "ZPHONENUMBERLABEL",
    "ZPHONESTATUS",
    "ZABOUTTEXT",
    "ZABOUTEMOJI",
    "ZABOUTTIMESTAMP",
    "ZABOUTEXPIRATIONTIMESTAMP",
    "ZNOTES",
    "ZDISAPPEARINGMODEDURATION",
    "ZDISAPPEARINGMODETIMESTAMP",
    "ZSOURCE",
    "ZSYNCPOLICY",
    "ZLASTUPDATED"
  ]
};
var ContactsSnapshot = class {
  #database;
  constructor(path) {
    this.#database = new AppDatabase(path, WhatsAppUnavailableError);
    this.#database.requireColumns(requiredColumns4, WhatsAppSchemaError);
  }
  contacts() {
    return this.#database.all(`SELECT ZUNIQUEID AS uniqueId, ZWHATSAPPID AS whatsappId, ZLID AS lid,
                ZINTEROPJID AS interopJid, ZIDENTIFIER AS identifier,
                ZFULLNAME AS fullName, ZGIVENNAME AS givenName,
                ZLASTNAME AS lastName, ZBUSINESSNAME AS businessName,
                ZHIGHLIGHTEDNAME AS highlightedName, ZUSERNAME AS username,
                ZPHONENUMBER AS phoneNumber,
                ZLOCALIZEDPHONENUMBER AS localizedPhoneNumber,
                ZPHONENUMBERLABEL AS phoneNumberLabel,
                ZPHONESTATUS AS phoneStatus, ZABOUTTEXT AS aboutText,
                ZABOUTEMOJI AS aboutEmoji, ZABOUTTIMESTAMP AS aboutTimestamp,
                ZABOUTEXPIRATIONTIMESTAMP AS aboutExpirationTimestamp,
                ZNOTES AS notes,
                ZDISAPPEARINGMODEDURATION AS disappearingModeDuration,
                ZDISAPPEARINGMODETIMESTAMP AS disappearingModeTimestamp,
                ZSOURCE AS source, ZSYNCPOLICY AS syncPolicy,
                ZLASTUPDATED AS lastUpdated
         FROM ZWAADDRESSBOOKCONTACT ORDER BY Z_PK`).map((row) => ({
      uniqueId: requiredText(row.uniqueId, "A WhatsApp contact has no ID"),
      whatsappId: text(row.whatsappId),
      lid: text(row.lid),
      interopJid: text(row.interopJid),
      identifier: text(row.identifier),
      fullName: text(row.fullName),
      givenName: text(row.givenName),
      lastName: text(row.lastName),
      businessName: text(row.businessName),
      highlightedName: text(row.highlightedName),
      username: text(row.username),
      phoneNumber: text(row.phoneNumber),
      localizedPhoneNumber: text(row.localizedPhoneNumber),
      phoneNumberLabel: text(row.phoneNumberLabel),
      phoneStatus: number(row.phoneStatus),
      aboutText: text(row.aboutText),
      aboutEmoji: text(row.aboutEmoji),
      aboutTimestamp: instant(row.aboutTimestamp),
      aboutExpirationTimestamp: instant(row.aboutExpirationTimestamp),
      notes: text(row.notes),
      disappearingModeDuration: number(row.disappearingModeDuration),
      disappearingModeTimestamp: instant(row.disappearingModeTimestamp),
      source: number(row.source),
      syncPolicy: number(row.syncPolicy),
      lastUpdated: instant(row.lastUpdated)
    }));
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
};

// packages/sdks/whatsapp/desktop/dist/key-values.js
var requiredColumns5 = {
  ZWAKEYVALUEELEMENT: ["Z_PK", "ZNAMESPACE", "ZKEY", "ZVALUE", "ZDATE"]
};
var KeyValueSnapshot = class {
  #database;
  constructor(path) {
    this.#database = new AppDatabase(path, WhatsAppUnavailableError);
    this.#database.requireColumns(requiredColumns5, WhatsAppSchemaError);
  }
  elements(namespace) {
    return this.#database.all(`SELECT ZKEY AS key, ZVALUE AS value, ZDATE AS date
         FROM ZWAKEYVALUEELEMENT WHERE ZNAMESPACE = ? ORDER BY ZSORT, Z_PK`, namespace).map((row) => {
      const value = bytes(row.value);
      if (value === null)
        throw new TypeError(`A WhatsApp ${namespace} entry has no value`);
      return {
        key: requiredText(row.key, `A WhatsApp ${namespace} entry has no key`),
        value,
        date: instant(row.date)
      };
    });
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
};
var utf8 = (value) => new TextDecoder("utf-8", { fatal: true }).decode(value);
var LocalKeyValueSnapshot = class extends KeyValueSnapshot {
  privacySettings() {
    return this.elements("privacy-settings-values").map(({ key: key2, value }) => ({
      category: key2,
      value: utf8(value)
    }));
  }
  // A protobuf of the timer in seconds (1) and when it was set in Unix
  // seconds (2), 0 when never.
  disappearingModes() {
    return this.elements("disappearing-mode").map(({ key: key2, value }) => {
      const mode = new ProtobufMessage(value);
      const setAt = mode.uint(2) ?? 0;
      return {
        lid: key2,
        durationSeconds: mode.uint(1) ?? 0,
        setAt: setAt === 0 ? null : unixSecondInstant(setAt)
      };
    });
  }
  // A JSON list of { type, username, url, vid }; vid is a token for the
  // viewer and is not read.
  linkedProfiles() {
    return this.elements("linked-profiles").flatMap(({ key: key2, value }) => {
      const profiles = JSON.parse(utf8(value));
      if (!Array.isArray(profiles))
        throw new TypeError("WhatsApp linked profiles are not a list");
      return profiles.map((profile2) => {
        if (typeof profile2 !== "object" || profile2 === null)
          throw new TypeError("A WhatsApp linked profile is not an object");
        const type = "type" in profile2 ? profile2.type : void 0;
        const username = "username" in profile2 ? profile2.username : void 0;
        const url = "url" in profile2 ? profile2.url : void 0;
        return {
          lid: key2,
          type: requiredText(type, "A WhatsApp linked profile has no type"),
          username: typeof username === "string" ? username : null,
          url: typeof url === "string" ? url : null
        };
      });
    });
  }
  changedNumbers() {
    return this.elements("changenumber-oldtonew").map(({ key: key2, value, date }) => ({
      oldJid: key2,
      newJid: utf8(value),
      changedAt: date
    }));
  }
};
var BackedUpKeyValueSnapshot = class extends KeyValueSnapshot {
  // Keyed by the sticker's file hash; the date is when it was favorited.
  favoriteStickers() {
    return this.elements("fs.v2").map(({ key: key2, date }) => ({
      fileHash: key2,
      favoritedAt: date
    }));
  }
  // One protobuf whose repeated field 1 lists the stickers by score, each
  // with its file hash (1), score (2) and last use (3).
  recentStickers() {
    return this.elements("rs.v2").flatMap(({ value }) => new ProtobufMessage(value).messages(1).map((entry, position2) => ({
      fileHash: requiredText(entry.string(1), "A recent WhatsApp sticker has no hash"),
      position: position2,
      score: entry.float(2) ?? null,
      lastUsed: entry.uint(3) ?? null
    })));
  }
};

// packages/sdks/whatsapp/desktop/dist/message-associations.js
var requiredColumns6 = {
  message_parent_association: [
    "stanza_id",
    "parent_stanza_id",
    "type",
    "sort",
    "chat_jid"
  ]
};
var MessageAssociationsSnapshot = class {
  #database;
  constructor(path) {
    this.#database = new AppDatabase(path, WhatsAppUnavailableError);
    this.#database.requireColumns(requiredColumns6, WhatsAppSchemaError);
  }
  associations() {
    return this.#database.all(`SELECT chat_jid AS chatJid, stanza_id AS stanzaId, type,
                parent_stanza_id AS parentStanzaId, sort
         FROM message_parent_association ORDER BY chat_jid, sort, stanza_id`).map((row) => ({
      chatJid: requiredText(row.chatJid, "A WhatsApp association has no chat"),
      stanzaId: requiredText(row.stanzaId, "A WhatsApp association has no message"),
      type: Number(row.type),
      parentStanzaId: requiredText(row.parentStanzaId, "A WhatsApp association has no parent"),
      sort: Number(row.sort)
    }));
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
};

// packages/sdks/whatsapp/desktop/dist/receipt-info.js
var packedServers = /* @__PURE__ */ new Map([
  [129, "s.whatsapp.net"],
  [140, "lid"],
  [131, "bot"]
]);
function packedJid(bytes2) {
  const [first] = bytes2;
  const server = first === void 0 ? void 0 : packedServers.get(first);
  const digits = Buffer.from(bytes2.subarray(1)).toString("hex").replace(/f$/, "");
  if (server === void 0 || !/^\d+$/.test(digits))
    throw new TypeError(`A WhatsApp receipt names a recipient this reader does not read (${Buffer.from(bytes2).toString("hex")})`);
  return `${digits}@${server}`;
}
function offsetInstant(base, offset) {
  if (offset === void 0)
    return null;
  if (base === void 0)
    throw new TypeError("A WhatsApp receipt has an offset but no base time");
  return unixSecondInstant(base + offset);
}
var ReceiptInfo = class {
  receipts;
  reactions;
  reactionCounts;
  constructor(bytes2) {
    const info = new ProtobufMessage(bytes2);
    const base = info.uint(3);
    this.receipts = info.messages(2).map((recipient) => {
      const jid23 = recipient.bytes(1);
      if (jid23 === void 0)
        throw new TypeError("A WhatsApp receipt names no recipient");
      return {
        recipientJid: packedJid(jid23),
        deliveredAt: offsetInstant(base, recipient.uint(4)),
        readAt: offsetInstant(base, recipient.uint(5)),
        playedAt: offsetInstant(base, recipient.uint(6))
      };
    });
    const reactions = info.message(7);
    this.reactions = (reactions?.messages(1) ?? []).map((reaction) => {
      const stanzaId = reaction.string(1);
      const emoji = reaction.string(3);
      const reactedAt = reaction.uint(4);
      if (stanzaId === void 0 || reactedAt === void 0)
        throw new TypeError("A WhatsApp reaction lacks its ID or time");
      return {
        stanzaId,
        senderJid: reaction.string(2) ?? null,
        isFromMe: reaction.uint(6) === 1,
        emoji: emoji ?? null,
        reactedAt: new Date(reactedAt).toISOString()
      };
    });
    this.reactionCounts = (reactions?.message(3)?.messages(1) ?? []).map((counted) => {
      const emoji = counted.string(1);
      const count = counted.uint(2);
      if (emoji === void 0 || count === void 0)
        throw new TypeError("A WhatsApp reaction count lacks its emoji");
      return { emoji, count };
    });
  }
};

// packages/sdks/whatsapp/desktop/dist/statuses.js
var statusLifetimeMs = 24 * 36e5;
var requiredColumns7 = {
  status: [
    "row_id",
    "sender_user_jid",
    "uuid",
    "type",
    "sort_id",
    "timestamp",
    "server_receipt_timestamp",
    "received_timestamp",
    "text_data",
    "state",
    "origin",
    "flags",
    "is_archived",
    "audience_type"
  ],
  status_text: [
    "status_row_id",
    "url",
    "page_title",
    "page_description",
    "font_style",
    "text_color",
    "background_color",
    "preview_type"
  ],
  status_media_link: ["status_row_id", "media_content_row_id"],
  media_content: [
    "row_id",
    "mime_type",
    "width",
    "height",
    "file_size",
    "media_duration",
    "accessibility_label",
    "file_hash",
    "file_path"
  ]
};
function instant2(value) {
  return value === null ? null : new Date((Number(value) + 978307200) * 1e3).toISOString();
}
var StatusesSnapshot = class {
  #database;
  #container;
  constructor(path, container) {
    this.#database = new AppDatabase(path, WhatsAppUnavailableError);
    this.#database.requireColumns(requiredColumns7, WhatsAppSchemaError);
    this.#container = container;
  }
  statuses() {
    return this.#database.all(`SELECT status.sender_user_jid AS senderJid, status.uuid,
                status.type, status.sort_id AS sortId, status.timestamp,
                status.server_receipt_timestamp AS serverReceiptTimestamp,
                status.received_timestamp AS receivedTimestamp,
                status.text_data AS text, status.state, status.origin,
                status.flags, status.is_archived AS isArchived,
                status.audience_type AS audienceType, styled.url,
                styled.page_title AS pageTitle,
                styled.page_description AS pageDescription,
                styled.font_style AS fontStyle,
                styled.text_color AS textColor,
                styled.background_color AS backgroundColor,
                styled.preview_type AS previewType,
                media.mime_type AS mimeType, media.width, media.height,
                media.file_size AS fileSize,
                media.media_duration AS mediaDuration,
                media.accessibility_label AS accessibilityLabel,
                media.file_hash AS fileHash, media.file_path AS filePath
         FROM status
         LEFT JOIN status_text AS styled ON styled.status_row_id = status.row_id
         LEFT JOIN status_media_link AS link ON link.status_row_id = status.row_id
         LEFT JOIN media_content AS media ON media.row_id = link.media_content_row_id
         ORDER BY status.row_id`).map((row) => {
      const filePath = text(row.filePath);
      return {
        senderJid: requiredText(row.senderJid, "A WhatsApp status has no sender"),
        uuid: requiredText(row.uuid, "A WhatsApp status has no ID"),
        type: Number(row.type),
        sortId: number(row.sortId),
        timestamp: instant2(row.timestamp),
        serverReceiptTimestamp: instant2(row.serverReceiptTimestamp),
        receivedTimestamp: instant2(row.receivedTimestamp),
        text: text(row.text),
        state: number(row.state),
        origin: number(row.origin),
        flags: number(row.flags),
        isArchived: flag(row.isArchived),
        audienceType: number(row.audienceType),
        url: text(row.url),
        pageTitle: text(row.pageTitle),
        pageDescription: text(row.pageDescription),
        fontStyle: number(row.fontStyle),
        textColor: number(row.textColor),
        backgroundColor: number(row.backgroundColor),
        previewType: number(row.previewType),
        mimeType: text(row.mimeType),
        width: number(row.width),
        height: number(row.height),
        fileSize: number(row.fileSize),
        mediaDuration: number(row.mediaDuration),
        accessibilityLabel: text(row.accessibilityLabel),
        fileHash: text(row.fileHash),
        filePath,
        file: filePath === null ? null : onDisk(messageMediaFile(this.#container, filePath))
      };
    });
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
};

// packages/sdks/whatsapp/desktop/dist/stickers.js
import { join as join2 } from "node:path";
var requiredColumns8 = {
  ZWACDABSTRACTSTICKERPACK: [
    "Z_PK",
    "Z_ENT",
    "ZSTICKERPACKID",
    "ZNAME",
    "ZPUBLISHER",
    "ZPACKDESCRIPTION",
    "ZFILESIZE",
    "ZSTICKERCOUNT",
    "ZPREMIUMSTICKERCOUNT",
    "ZORDER",
    "ZFLAGS",
    "ZFLAGS1",
    "ZIMAGEDATAHASH",
    "ZTRAYIMAGEID",
    "ZTRAYIMAGEFILEPATH",
    "ZPREVIEWIMAGEIDS"
  ],
  ZWACDSTICKER: [
    "Z_PK",
    "ZFILEHASH",
    "ZSTICKERPACK",
    "ZSORT",
    "ZMIMETYPE",
    "ZWIDTH",
    "ZHEIGHT",
    "ZFILELENGTH",
    "ZFLAGS",
    "ZEMOJIS",
    "ZACCESSIBILITYTEXT",
    "ZIMAGEHASH",
    "ZRELATIVEIMAGEPATH"
  ],
  Z_PRIMARYKEY: ["Z_ENT", "Z_NAME"]
};
function stickerFile(container, relativePath) {
  return join2(container, "stickers", relativePath);
}
var StickersSnapshot = class {
  #database;
  #container;
  #tray;
  #store;
  constructor(path, container) {
    this.#container = container;
    this.#database = new AppDatabase(path, WhatsAppUnavailableError);
    this.#database.requireColumns(requiredColumns8, WhatsAppSchemaError);
    try {
      this.#tray = this.#entity("WACDStickerPack");
      this.#store = this.#entity("WACDStoreStickerPack");
    } catch (error) {
      this.#database[Symbol.dispose]();
      throw error;
    }
  }
  packs() {
    return this.#database.all(`SELECT Z_ENT AS entity, ZSTICKERPACKID AS stickerPackId, ZNAME AS name,
                ZPUBLISHER AS publisher, ZPACKDESCRIPTION AS description,
                ZFILESIZE AS fileSize, ZSTICKERCOUNT AS stickerCount,
                ZPREMIUMSTICKERCOUNT AS premiumStickerCount, ZORDER AS "order",
                ZFLAGS AS trayFlags, ZFLAGS1 AS storeFlags,
                ZIMAGEDATAHASH AS imageDataHash, ZTRAYIMAGEID AS trayImageId,
                ZTRAYIMAGEFILEPATH AS trayImageFilePath,
                ZPREVIEWIMAGEIDS AS previewImageIds
         FROM ZWACDABSTRACTSTICKERPACK WHERE Z_ENT IN (?, ?) ORDER BY Z_PK`, this.#tray, this.#store).map((row) => {
      const inTray = Number(row.entity) === this.#tray;
      return {
        stickerPackId: requiredText(row.stickerPackId, "A WhatsApp sticker pack has no ID"),
        inTray,
        name: text(row.name),
        publisher: text(row.publisher),
        description: text(row.description),
        fileSize: number(row.fileSize),
        stickerCount: number(row.stickerCount),
        premiumStickerCount: number(row.premiumStickerCount),
        order: number(row.order),
        // Core Data stores each subentity's own flags attribute in its own
        // column.
        flags: number(inTray ? row.trayFlags : row.storeFlags),
        imageDataHash: text(row.imageDataHash),
        trayImageId: text(row.trayImageId),
        trayImageFilePath: text(row.trayImageFilePath),
        previewImageIds: previewImageIds(row.previewImageIds)
      };
    });
  }
  stickers() {
    return this.#database.all(`SELECT sticker.ZFILEHASH AS fileHash,
                pack.ZSTICKERPACKID AS stickerPackId, sticker.ZSORT AS sort,
                sticker.ZMIMETYPE AS mimeType, sticker.ZWIDTH AS width,
                sticker.ZHEIGHT AS height, sticker.ZFILELENGTH AS fileLength,
                sticker.ZFLAGS AS flags, sticker.ZEMOJIS AS emojis,
                sticker.ZACCESSIBILITYTEXT AS accessibilityText,
                sticker.ZIMAGEHASH AS imageHash,
                sticker.ZRELATIVEIMAGEPATH AS relativeImagePath
         FROM ZWACDSTICKER AS sticker
         LEFT JOIN ZWACDABSTRACTSTICKERPACK AS pack
           ON pack.Z_PK = sticker.ZSTICKERPACK
         ORDER BY sticker.Z_PK`).map((row) => {
      const relativeImagePath = text(row.relativeImagePath);
      return {
        fileHash: requiredText(row.fileHash, "A WhatsApp sticker has no hash"),
        stickerPackId: text(row.stickerPackId),
        sort: number(row.sort),
        mimeType: text(row.mimeType),
        width: number(row.width),
        height: number(row.height),
        fileLength: number(row.fileLength),
        flags: number(row.flags),
        emojis: text(row.emojis),
        accessibilityText: text(row.accessibilityText),
        imageHash: text(row.imageHash),
        relativeImagePath,
        file: relativeImagePath === null ? null : onDisk(stickerFile(this.#container, relativeImagePath))
      };
    });
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
  // A subentity's number, which changes between model versions.
  #entity(name) {
    const [row] = this.#database.all("SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = ?", name);
    if (row === void 0)
      throw new WhatsAppSchemaError(this.#database.path, [
        `Z_PRIMARYKEY.${name}`
      ]);
    return Number(row.Z_ENT);
  }
};
function previewImageIds(value) {
  const archive = bytes(value);
  if (archive === null)
    return [];
  const ids = decodeArchive(archive);
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
    throw new TypeError("WhatsApp sticker previews are not a list of IDs");
  return ids;
}

// packages/sdks/whatsapp/desktop/dist/users.js
var requiredColumns9 = {
  ZWAZACCOUNT: [
    "Z_PK",
    "ZIDENTIFIER",
    "ZPHONENUMBER",
    "ZCOUNTRYCODE",
    "ZDISPLAYNAME",
    "ZUSERNAME",
    "ZUSERTYPE",
    "ZSTATE",
    "ZCURRENTPHONENUMBERSHARINGSTATE",
    "ZUSERNAMESTATE",
    "ZCREATEDAT",
    "ZADDITIONALDATA"
  ]
};
var UsersSnapshot = class {
  #database;
  constructor(path) {
    this.#database = new AppDatabase(path, WhatsAppUnavailableError);
    this.#database.requireColumns(requiredColumns9, WhatsAppSchemaError);
  }
  users() {
    return this.#database.all(`SELECT ZIDENTIFIER AS lid, ZPHONENUMBER AS phoneNumber,
                ZCOUNTRYCODE AS countryCode, ZDISPLAYNAME AS displayName,
                ZUSERNAME AS username, ZUSERTYPE AS userType, ZSTATE AS state,
                ZCURRENTPHONENUMBERSHARINGSTATE AS phoneNumberSharingState,
                ZUSERNAMESTATE AS usernameState, ZCREATEDAT AS createdAt,
                ZADDITIONALDATA AS additionalData
         FROM ZWAZACCOUNT ORDER BY Z_PK`).map((row) => ({
      lid: requiredText(row.lid, "A WhatsApp user has no LID"),
      phoneNumber: text(row.phoneNumber),
      countryCode: text(row.countryCode),
      displayName: text(row.displayName),
      username: text(row.username),
      userType: number(row.userType),
      state: number(row.state),
      phoneNumberSharingState: number(row.phoneNumberSharingState),
      usernameState: number(row.usernameState),
      createdAt: instant(row.createdAt),
      additionalData: bytes(row.additionalData)
    }));
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
};

// packages/sdks/whatsapp/desktop/dist/whatsapp.js
import { homedir } from "node:os";
import { join as join3 } from "node:path";
var whatsappContainer = join3(homedir(), "Library/Group Containers/group.net.whatsapp.WhatsApp.shared");
var storeFiles = {
  chatStorage: "ChatStorage.sqlite",
  contacts: "ContactsV2.sqlite",
  users: "LID.sqlite",
  calls: "CallHistory.sqlite",
  messageAssociations: "ExtChatDB/ExtChatDatabase.sqlite",
  businesses: "Biz/Biz.sqlite",
  statuses: "statusDB/Status.sqlite",
  stickers: "Sticker.sqlite",
  localKeyValue: "LocalKeyValue.sqlite",
  backedUpKeyValue: "BackedUpKeyValue.sqlite"
};
var WhatsApp = class {
  container;
  constructor(container = whatsappContainer) {
    this.container = container;
  }
  chatStorage() {
    return new ChatStorageSnapshot(this.#file("chatStorage"), this.container);
  }
  contacts() {
    return new ContactsSnapshot(this.#file("contacts"));
  }
  users() {
    return new UsersSnapshot(this.#file("users"));
  }
  calls() {
    return new CallsSnapshot(this.#file("calls"));
  }
  messageAssociations() {
    return new MessageAssociationsSnapshot(this.#file("messageAssociations"));
  }
  businesses() {
    return new BusinessesSnapshot(this.#file("businesses"));
  }
  statuses() {
    return new StatusesSnapshot(this.#file("statuses"), this.container);
  }
  stickers() {
    return new StickersSnapshot(this.#file("stickers"), this.container);
  }
  localKeyValue() {
    return new LocalKeyValueSnapshot(this.#file("localKeyValue"));
  }
  backedUpKeyValue() {
    return new BackedUpKeyValueSnapshot(this.#file("backedUpKeyValue"));
  }
  // A probe whose current value changes with each commit to the store.
  version(store) {
    return new WhatsAppVersion(this.#file(store));
  }
  #file(store) {
    return join3(this.container, storeFiles[store]);
  }
};
var WhatsAppVersion = class {
  #path;
  #probe;
  constructor(path) {
    this.#path = path;
  }
  get current() {
    try {
      this.#probe ??= new AppDatabaseVersion(this.#path, WhatsAppUnavailableError);
    } catch (error) {
      if (error instanceof WhatsAppUnavailableError)
        return "missing";
      throw error;
    }
    return String(this.#probe.current);
  }
  [Symbol.dispose]() {
    this.#probe?.[Symbol.dispose]();
  }
};

// packages/sources/whatsapp/desktop/dist/whatsapp-stream.js
var text2 = { type: "string" };
var nullableText = { type: ["string", "null"] };
var whatsappFields = {
  jid: { ...text2, minLength: 1 },
  nullableJid: { ...nullableText, minLength: 1 },
  text: text2,
  nullableText,
  integer: { type: "integer" },
  nullableInteger: { type: ["integer", "null"] },
  nullableNumber: { type: ["number", "null"] },
  boolean: { type: "boolean" },
  nullableBoolean: { type: ["boolean", "null"] },
  // Core Data's dates: seconds since 2001 in a double, to the microsecond.
  instant: { ...text2, format: "date-time", precision: 6 },
  nullableInstant: { ...nullableText, format: "date-time", precision: 6 },
  nullableBase64: { ...nullableText, contentEncoding: "base64" }
};
var base64 = (bytes2) => bytes2 === null ? null : Buffer.from(bytes2).toString("base64");
var WhatsAppStream = class {
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
    return validateRecords(this, this.rows(scan).map((row) => this.record(row)), "WhatsApp");
  }
  // The instant WhatsApp keeps the stream's records from, for streams it
  // expires (see Stream.expiresBy).
  horizon(_scan) {
    return void 0;
  }
  // The file a record carries, for streams that support file reads.
  file(_record, _scan) {
    return null;
  }
};

// packages/sources/whatsapp/desktop/dist/streams/blocked-contacts-stream.js
var properties = {
  jid: {
    ...whatsappFields.jid,
    description: "The person this account blocked (ZJID); the primary key."
  }
};
var BlockedContactsStream = class extends WhatsAppStream {
  name = "blockedContacts";
  store = "chatStorage";
  primaryKey = ["jid"];
  jsonSchema = {
    type: "object",
    description: "One record per person this account blocked on WhatsApp (ZWABLACKLISTITEM). Primary key jid. Not narrowed by an import\u2019s chats or dates.",
    properties,
    required: Object.keys(properties)
  };
  rows(scan) {
    return scan.chatStorage.blockedJids;
  }
  record(jid23) {
    return { jid: jid23 };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/business-bot-prompts-stream.js
var { jid, text: text3, integer, nullableText: nullableText2 } = whatsappFields;
var properties2 = {
  jid: { ...jid, description: "The business; refers to businessProfiles.jid." },
  text: {
    ...text3,
    minLength: 1,
    description: "The question the chat offers to start with (ZWABIZBOTPROMPTDATA.ZTEXT)."
  },
  position: {
    ...integer,
    minimum: 0,
    description: "The prompt\u2019s place among the business\u2019s prompts."
  },
  emoji: { ...nullableText2, description: "The prompt\u2019s emoji (ZEMOJI)." }
};
var BusinessBotPromptsStream = class extends WhatsAppStream {
  name = "businessBotPrompts";
  store = "businesses";
  primaryKey = ["jid", "text"];
  jsonSchema = {
    type: "object",
    description: "One record per suggested question a business\u2019s automated agent offers in its chat. Primary key jid, text. Not narrowed by an import\u2019s chats or dates.",
    properties: properties2,
    required: Object.keys(properties2)
  };
  rows(scan) {
    return scan.businesses.botPrompts();
  }
  record(prompt) {
    return { ...prompt };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/business-categories-stream.js
var { jid: jid2, text: text4, integer: integer2, nullableText: nullableText3 } = whatsappFields;
var properties3 = {
  jid: { ...jid2, description: "The business; refers to businessProfiles.jid." },
  categoryId: {
    ...text4,
    minLength: 1,
    description: "WhatsApp\u2019s category ID (ZWABIZCATEGORYDATA.ZCATEGORYID)."
  },
  position: {
    ...integer2,
    minimum: 0,
    description: "The category\u2019s place in the profile; 0 is the main one."
  },
  name: { ...nullableText3, description: "The category\u2019s name (ZNAME)." }
};
var BusinessCategoriesStream = class extends WhatsAppStream {
  name = "businessCategories";
  store = "businesses";
  primaryKey = ["jid", "categoryId"];
  jsonSchema = {
    type: "object",
    description: "One record per category a business profile lists. Primary key jid, categoryId. Not narrowed by an import\u2019s chats or dates.",
    properties: properties3,
    required: Object.keys(properties3)
  };
  rows(scan) {
    return scan.businesses.categories();
  }
  record(category) {
    return { ...category };
  }
};

// packages/sources/whatsapp/desktop/dist/chat-storage-records.js
var messageId = ({ chatJid, isFromMe, stanzaId }) => JSON.stringify([chatJid, isFromMe, stanzaId]);
function unique(rows, key2) {
  const seen = /* @__PURE__ */ new Set();
  return rows.filter((row) => {
    const id = key2(row);
    if (seen.has(id))
      return false;
    seen.add(id);
    return true;
  });
}
var toMilliseconds = (instant5) => `${instant5.slice(0, 23)}Z`;
var ChatStorageRecords = class {
  #snapshot;
  #scope;
  #narrowed;
  #chats;
  #messages;
  #messageIds;
  #stanzaIds;
  #receiptInfos;
  constructor(snapshot, scope) {
    this.#snapshot = snapshot;
    this.#scope = scope;
    this.#narrowed = Object.keys(scope).length > 0;
  }
  get chats() {
    this.#chats ??= unique(this.#snapshot.chats().filter(({ jid: jid23 }) => this.#chat(jid23)), ({ jid: jid23 }) => jid23);
    return this.#chats;
  }
  get messages() {
    this.#messages ??= unique(this.#snapshot.messages().filter(({ chatJid, messageDate }) => this.#chat(chatJid) && withinDates(this.#scope, messageDate === null ? null : toMilliseconds(messageDate))), messageId);
    return this.#messages;
  }
  get receipts() {
    return this.#decoded().flatMap(({ message, item }) => item.receipts.map((receipt) => ({ message, item: receipt })));
  }
  get reactions() {
    return this.#decoded().flatMap(({ message, item }) => item.reactions.map((reaction) => ({ message, item: reaction })));
  }
  get reactionCounts() {
    return this.#decoded().flatMap(({ message, item }) => item.reactionCounts.map((count) => ({ message, item: count })));
  }
  get dataItems() {
    return this.#snapshot.dataItems().filter((item) => this.message(item));
  }
  get groupMembers() {
    return this.#snapshot.groupMembers().filter(({ groupJid }) => this.#chat(groupJid));
  }
  get groupMembersChanges() {
    return this.#snapshot.groupMembersChanges().filter(({ groupJid }) => this.#chat(groupJid));
  }
  get chatPushConfigs() {
    return this.#snapshot.chatPushConfigs().filter(({ jid: jid23 }) => this.#chat(jid23));
  }
  // Who people are and whom the account blocked belongs to no chat, so no
  // import scope narrows them.
  get pushNames() {
    return this.#snapshot.pushNames();
  }
  get profilePictures() {
    return this.#snapshot.profilePictures();
  }
  get blockedJids() {
    return this.#snapshot.blockedJids();
  }
  // Whether the import keeps the message a record of the same chat hangs
  // off, by its key.
  message(key2) {
    if (!this.#narrowed)
      return true;
    this.#messageIds ??= new Set(this.messages.map(messageId));
    return this.#messageIds.has(messageId(key2));
  }
  // The same for a record that names its message by chat and stanza ID only.
  stanza(chatJid, stanzaId) {
    if (!this.#narrowed)
      return true;
    this.#stanzaIds ??= new Set(this.messages.map((kept) => JSON.stringify([kept.chatJid, kept.stanzaId])));
    return this.#stanzaIds.has(JSON.stringify([chatJid, stanzaId]));
  }
  #chat(jid23) {
    return selected(this.#scope.collectionIds, jid23);
  }
  #decoded() {
    this.#receiptInfos ??= this.messages.flatMap((message) => message.receiptInfo === null ? [] : [{ message, item: new ReceiptInfo(message.receiptInfo) }]);
    return this.#receiptInfos;
  }
};

// packages/sources/whatsapp/desktop/dist/streams/business-hours-stream.js
var { jid: jid3, integer: integer3 } = whatsappFields;
var minutes = { ...integer3, minimum: 0, maximum: 1440 };
var properties4 = {
  jid: { ...jid3, description: "The business; refers to businessProfiles.jid." },
  day: {
    ...integer3,
    minimum: 1,
    maximum: 7,
    description: "The day, 1 Sunday through 7 Saturday."
  },
  openTime: {
    ...minutes,
    description: "When it opens, in minutes after midnight in the business\u2019s time zone; 0 when open all day or by appointment."
  },
  mode: {
    ...integer3,
    description: "How it keeps the day: 0 open all day, 1 set hours, 2 by appointment only."
  },
  closeTime: {
    ...minutes,
    description: "When it closes, in minutes after midnight."
  }
};
var BusinessHoursStream = class extends WhatsAppStream {
  name = "businessHours";
  store = "businesses";
  primaryKey = ["jid", "day", "openTime"];
  jsonSchema = {
    type: "object",
    description: "One record per opening a business profile lists for a day of the week (ZWABIZPROFILEDATA.ZHOURSCONFIGS); a day it is closed has none. Primary key jid, day, openTime; a profile that repeats a day\u2019s hours lists them once. Not narrowed by an import\u2019s chats or dates.",
    properties: properties4,
    required: Object.keys(properties4)
  };
  rows(scan) {
    return unique(scan.businesses.hours(), ({ jid: jid23, day, openTime }) => JSON.stringify([jid23, day, openTime]));
  }
  record(hours) {
    return { ...hours };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/business-profiles-stream.js
var { jid: jid4, text: text5, nullableText: nullableText4, nullableInteger, nullableNumber, nullableBoolean, nullableInstant } = whatsappFields;
var profile = (what, column5) => `${what} (ZWABIZPROFILEDATA.${column5}).`;
var properties5 = {
  jid: {
    ...jid4,
    description: profile("The business, by phone JID; the primary key", "ZJID")
  },
  description: {
    ...nullableText4,
    description: profile("The business\u2019s About text", "ZBUSINESSDESCRIPTION")
  },
  address: { ...nullableText4, description: profile("The address", "ZADDRESS") },
  latitude: {
    ...nullableNumber,
    description: profile("The map pin\u2019s latitude", "ZLATITUDE")
  },
  longitude: {
    ...nullableNumber,
    description: profile("The map pin\u2019s longitude", "ZLONGITUDE")
  },
  email: {
    ...nullableText4,
    description: profile("The email address", "ZEMAIL")
  },
  websites: {
    type: "array",
    items: text5,
    description: profile("The websites, in order", "ZWEBSITES")
  },
  timezone: {
    ...nullableText4,
    description: profile("The time zone its hours are in, IANA", "ZTIMEZONE")
  },
  memberSinceDate: {
    ...nullableInstant,
    description: profile("When the business joined WhatsApp, UTC", "ZMEMBERSINCEDATE")
  },
  memberSinceText: {
    ...nullableText4,
    description: profile("That date as WhatsApp words it", "ZMEMBERSINCETEXT")
  },
  customUrl: {
    ...nullableText4,
    description: profile("The business\u2019s short link name", "ZCUSTOMURL")
  },
  vertical: {
    ...nullableText4,
    description: profile("The industry", "ZVERTICAL")
  },
  canonicalVertical: {
    ...nullableText4,
    description: profile("The industry as WhatsApp files it", "ZCANONICALVERTICAL")
  },
  parentCompanyName: {
    ...nullableText4,
    description: profile("The parent company", "ZPARENTCOMPANYNAME")
  },
  parentCompanyLogoUrl: {
    ...nullableText4,
    description: profile("The parent company\u2019s logo", "ZPARENTCOMPANYLOGOURL")
  },
  isAuthorizedAgent: {
    ...nullableBoolean,
    description: profile("Whether it is an authorized agent", "ZISAUTHORIZEDAGENT")
  },
  commerceExperience: {
    ...nullableText4,
    description: "Whether it sells through a catalog: none, catalog or smb_meta_catalog (ZWABIZPROFILEOPTIONSDATA.ZCOMMERCEEXPERIENCE)."
  },
  cartEnabled: {
    ...nullableBoolean,
    description: "Whether its catalog has a cart (ZCARTENABLED)."
  },
  shopUrl: { ...nullableText4, description: "Its shop\u2019s address (ZSHOPURL)." },
  isVideoCallingEnabled: {
    ...nullableBoolean,
    description: "Whether it takes video calls (ZISVIDEOCALLINGENABLED)."
  },
  automatedType: {
    ...nullableText4,
    description: "How far an automated agent answers its chats, such as 1p_partial (ZWABIZBOTDATA.ZAUTOMATEDTYPE)."
  },
  coverPhotoId: {
    ...nullableText4,
    description: "The cover photo\u2019s ID (ZWABIZCOVERPHOTODATA.ZIMAGEID)."
  },
  coverPhotoUrl: {
    ...nullableText4,
    description: "The cover photo on WhatsApp\u2019s servers; the link expires (ZURL)."
  },
  facebookPageId: {
    ...nullableText4,
    description: "Its linked Facebook page\u2019s ID (ZLINKEDACCOUNTS field 1.1)."
  },
  facebookPageName: {
    ...nullableText4,
    description: "Its linked Facebook page\u2019s name (field 1.2)."
  },
  facebookLikes: {
    ...nullableInteger,
    description: "That page\u2019s likes (field 1.3)."
  },
  instagramHandle: {
    ...nullableText4,
    description: "Its linked Instagram account (field 2.1)."
  },
  instagramFollowers: {
    ...nullableInteger,
    description: "That account\u2019s followers (field 2.2)."
  }
};
var BusinessProfilesStream = class extends WhatsAppStream {
  name = "businessProfiles";
  store = "businesses";
  primaryKey = ["jid"];
  jsonSchema = {
    type: "object",
    description: "One record per business profile WhatsApp fetched for a chat with a business (Biz.sqlite), as the profile screen shows it. Primary key jid; a chat may name the business by its LID instead, which businessVerifiedNames maps. Not narrowed by an import\u2019s chats or dates.",
    properties: properties5,
    required: Object.keys(properties5)
  };
  rows(scan) {
    return scan.businesses.profiles();
  }
  record(profile2) {
    return { ...profile2, websites: [...profile2.websites] };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/business-service-areas-stream.js
var { jid: jid5, integer: integer4, nullableNumber: nullableNumber2, nullableText: nullableText5 } = whatsappFields;
var properties6 = {
  jid: { ...jid5, description: "The business; refers to businessProfiles.jid." },
  position: {
    ...integer4,
    minimum: 0,
    description: "The area\u2019s place in the profile\u2019s list."
  },
  latitude: {
    ...nullableNumber2,
    description: "The area\u2019s center (ZWABIZSERVICEAREADATA.ZLATITUDE)."
  },
  longitude: {
    ...nullableNumber2,
    description: "The area\u2019s center (ZLONGITUDE)."
  },
  radiusMeters: {
    ...nullableNumber2,
    minimum: 0,
    description: "The area\u2019s radius in meters (ZAREARADIUSMETERS)."
  },
  description: {
    ...nullableText5,
    description: "The area as the business describes it (ZAREADESCRIPTION)."
  }
};
var BusinessServiceAreasStream = class extends WhatsAppStream {
  name = "businessServiceAreas";
  store = "businesses";
  primaryKey = ["jid", "position"];
  jsonSchema = {
    type: "object",
    description: "One record per area a business profile says it serves. Areas have no ID, so the key is their place in the list: primary key jid, position. Not narrowed by an import\u2019s chats or dates.",
    properties: properties6,
    required: Object.keys(properties6)
  };
  rows(scan) {
    return scan.businesses.serviceAreas();
  }
  record(area) {
    return { ...area };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/business-verified-names-stream.js
var { jid: jid6, nullableJid, nullableText: nullableText6, nullableInteger: nullableInteger2, nullableInstant: nullableInstant2 } = whatsappFields;
var second = { ...nullableText6, format: "date-time", precision: 0 };
var properties7 = {
  lid: {
    ...jid6,
    description: "The business\u2019s LID; the primary key (ZWABIZVERIFIEDNAMEDATA.ZJID)."
  },
  phoneNumberJid: {
    ...nullableJid,
    description: "The business\u2019s phone JID; refers to businessProfiles.jid (ZPHONENUMBERJID)."
  },
  name: {
    ...nullableText6,
    description: "The name WhatsApp verified for the business (ZNAME)."
  },
  verificationLevel: {
    ...nullableInteger2,
    description: "How far WhatsApp verified it: 1 unknown, 2 low, 3 high (ZVERIFICATIONLEVEL)."
  },
  expires: {
    ...nullableInstant2,
    description: "When the verification expires, UTC (ZEXPIRES)."
  },
  certificateSerial: {
    ...nullableText6,
    format: "int64",
    description: "The name certificate\u2019s serial (ZCERTIFICATEDETAILS field 1)."
  },
  certificateIssuer: {
    ...nullableText6,
    description: "Who issued the certificate: smb:wa for the WhatsApp Business app, ent:wa for WhatsApp\u2019s business platform (field 2)."
  },
  certificateIssuedAt: {
    ...second,
    description: "When the certificate was issued, UTC (field 10)."
  },
  roleActor: {
    ...nullableInteger2,
    description: "For a business on WhatsApp\u2019s business platform, the server\u2019s undocumented actor code: who answers its chats (ZWABIZROLEDATA.ZACTOR)."
  },
  roleHostStorage: {
    ...nullableInteger2,
    description: "The server\u2019s undocumented code for where the business\u2019s chats are stored (ZHOSTSTORAGE)."
  },
  roleUpdatedAt: {
    ...second,
    description: "When the server last set that role, UTC (ZLASTUPDATETIME)."
  }
};
var BusinessVerifiedNamesStream = class extends WhatsAppStream {
  name = "businessVerifiedNames";
  store = "businesses";
  primaryKey = ["lid"];
  jsonSchema = {
    type: "object",
    description: "One record per business WhatsApp holds a verified name for, by LID, with the platform role of a business on WhatsApp\u2019s business platform (Biz.sqlite). Primary key lid. Not narrowed by an import\u2019s chats or dates.",
    properties: properties7,
    required: Object.keys(properties7)
  };
  rows(scan) {
    return scan.businesses.verifiedNames();
  }
  record(name) {
    return { ...name };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/call-participants-stream.js
var { text: text6, jid: jid7, nullableInteger: nullableInteger3 } = whatsappFields;
var properties8 = {
  callId: {
    ...text6,
    minLength: 1,
    description: "The call; refers to calls.callId."
  },
  jid: {
    ...jid7,
    description: "The other party (ZWACDCALLEVENTPARTICIPANT.ZJIDSTRING)."
  },
  outcome: {
    ...nullableInteger3,
    description: "WhatsApp\u2019s undocumented code for how the call went for them (ZOUTCOME)."
  }
};
var CallParticipantsStream = class extends WhatsAppStream {
  name = "callParticipants";
  store = "calls";
  primaryKey = ["callId", "jid"];
  jsonSchema = {
    type: "object",
    description: "One record per other party on a call. WhatsApp keeps participants on the call-log entry, so each call an entry holds lists them all. Primary key callId, jid. Not narrowed by an import\u2019s chats or dates.",
    properties: properties8,
    required: Object.keys(properties8)
  };
  rows(scan) {
    return scan.calls.participants();
  }
  record(participant) {
    return { ...participant };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/calls-stream.js
var { text: text7, nullableJid: nullableJid2, nullableText: nullableText7, nullableInteger: nullableInteger4, nullableNumber: nullableNumber3, nullableBoolean: nullableBoolean2, nullableInstant: nullableInstant3 } = whatsappFields;
var call = (what, name) => `${what} (ZWACDCALLEVENT.${name}).`;
var log = (what, name) => `${what}, from the call-log entry holding the call (ZWAAGGREGATECALLEVENT.${name}).`;
var properties9 = {
  callId: {
    ...text7,
    minLength: 1,
    description: call("The call\u2019s ID; the primary key", "ZCALLIDSTRING")
  },
  date: {
    ...nullableInstant3,
    description: call("When the call started, UTC", "ZDATE")
  },
  duration: {
    ...nullableNumber3,
    minimum: 0,
    description: call("How long the call lasted, in seconds", "ZDURATION")
  },
  outcome: {
    ...nullableInteger4,
    description: call("WhatsApp\u2019s undocumented code for how the call ended", "ZOUTCOME")
  },
  bytesSent: {
    ...nullableInteger4,
    description: call("Bytes sent", "ZBYTESSENT")
  },
  bytesReceived: {
    ...nullableInteger4,
    description: call("Bytes received", "ZBYTESRECEIVED")
  },
  groupJid: {
    ...nullableJid2,
    description: call("The group of a group call", "ZGROUPJIDSTRING")
  },
  groupCallCreatorJid: {
    ...nullableJid2,
    description: call("Who started a group call", "ZGROUPCALLCREATORUSERJIDSTRING")
  },
  isBotGroupCall: {
    ...nullableBoolean2,
    description: call("Whether a bot took part in the group call", "ZISBOTGROUPCALL")
  },
  isLightweight: {
    ...nullableBoolean2,
    description: call("WhatsApp\u2019s lightweight call flag", "ZISLIGHTWEIGHT")
  },
  reminderId: {
    ...nullableText7,
    description: call("The reminder set for the call", "ZREMINDERID")
  },
  scheduledId: {
    ...nullableText7,
    description: call("The scheduled call it was", "ZSCHEDULEDID")
  },
  incoming: {
    ...nullableBoolean2,
    description: log("Whether the call came in", "ZINCOMING")
  },
  missed: {
    ...nullableBoolean2,
    description: log("Whether the call was missed", "ZMISSED")
  },
  missedReason: {
    ...nullableInteger4,
    description: log("WhatsApp\u2019s undocumented reason code for a missed call", "ZMISSEDREASON")
  },
  video: {
    ...nullableBoolean2,
    description: log("Whether it was a video call", "ZVIDEO")
  },
  firstDate: {
    ...nullableInstant3,
    description: log("When the entry\u2019s first call started, UTC", "ZFIRSTDATE")
  },
  linkToken: {
    ...nullableText7,
    description: log("The call link\u2019s token", "ZLINKTOKEN")
  }
};
var CallsStream = class extends WhatsAppStream {
  name = "calls";
  store = "calls";
  primaryKey = ["callId"];
  jsonSchema = {
    type: "object",
    description: "One record per WhatsApp call (CallHistory.sqlite), with the call-log entry that holds it. Primary key callId. Not narrowed by an import\u2019s chats or dates.",
    properties: properties9,
    required: Object.keys(properties9)
  };
  rows(scan) {
    return scan.calls.calls();
  }
  record(call2) {
    return { ...call2 };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/changed-numbers-stream.js
var { jid: jid8, nullableInstant: nullableInstant4 } = whatsappFields;
var properties10 = {
  oldJid: {
    ...jid8,
    description: "The person\u2019s old phone JID; the primary key."
  },
  newJid: { ...jid8, description: "Their new phone JID." },
  changedAt: {
    ...nullableInstant4,
    description: "When WhatsApp learned of the change, UTC."
  }
};
var ChangedNumbersStream = class extends WhatsAppStream {
  name = "changedNumbers";
  store = "localKeyValue";
  primaryKey = ["oldJid"];
  jsonSchema = {
    type: "object",
    description: "One record per person WhatsApp saw move to a new phone number (LocalKeyValue.sqlite\u2019s changenumber-oldtonew). Primary key oldJid. Not narrowed by an import\u2019s chats or dates.",
    properties: properties10,
    required: Object.keys(properties10)
  };
  rows(scan) {
    return scan.localKeyValue.changedNumbers();
  }
  record(change) {
    return { ...change };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/chat-push-configs-stream.js
var { jid: jid9, nullableInteger: nullableInteger5, nullableText: nullableText8, nullableInstant: nullableInstant5 } = whatsappFields;
var properties11 = {
  jid: {
    ...jid9,
    description: "The chat; refers to chats.jid when WhatsApp still has it (ZJID)."
  },
  alerts: {
    ...nullableInteger5,
    description: "WhatsApp\u2019s undocumented code for the chat\u2019s alerts (ZALERTS)."
  },
  mutedUntil: {
    ...nullableInstant5,
    description: "When the chat\u2019s mute ends, UTC (ZMUTEDUNTIL); 4001-01-01 for a chat muted always."
  },
  sound: {
    ...nullableText8,
    description: "The chat\u2019s message sound (ZSOUND)."
  },
  ringtone: {
    ...nullableText8,
    description: "The chat\u2019s ringtone (ZRINGTONE)."
  }
};
var ChatPushConfigsStream = class extends WhatsAppStream {
  name = "chatPushConfigs";
  store = "chatStorage";
  primaryKey = ["jid"];
  jsonSchema = {
    type: "object",
    description: "One record per chat with its own notification settings, such as a mute (ZWACHATPUSHCONFIG). Primary key jid.",
    properties: properties11,
    required: Object.keys(properties11)
  };
  rows(scan) {
    return scan.chatStorage.chatPushConfigs;
  }
  record(config) {
    return { ...config };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/chats-stream.js
var { jid: jid10, nullableJid: nullableJid3, integer: integer5, nullableInteger: nullableInteger6, nullableText: nullableText9, nullableBoolean: nullableBoolean3, nullableInstant: nullableInstant6 } = whatsappFields;
var groupOnly = "NULL for a chat that is not a group.";
var properties12 = {
  jid: {
    ...jid10,
    description: "The chat\u2019s JID (ZWACHATSESSION.ZCONTACTJID): a person as <number>@s.whatsapp.net or <LID>@lid, a group as \u2026@g.us, a channel as \u2026@newsletter, a broadcast list as \u2026@broadcast, a contact\u2019s statuses as \u2026@lid.status. The primary key."
  },
  sessionType: {
    ...integer5,
    description: "WhatsApp\u2019s chat kind (ZSESSIONTYPE), seen as: 0 one person, 1 group, 2 broadcast list, 3 statuses, 4 a group kept apart from type 1, 5 channel. WhatsApp documents none of them."
  },
  partnerName: {
    ...nullableText9,
    description: "The name WhatsApp shows for the chat: the group subject, or the person\u2019s name (ZPARTNERNAME)."
  },
  contactIdentifier: {
    ...nullableText9,
    description: "The macOS Contacts identifier of the person (ZCONTACTIDENTIFIER); NULL when not linked."
  },
  contactAbId: {
    ...nullableInteger6,
    description: "The address book record number of the person (ZCONTACTABID)."
  },
  archived: {
    ...nullableBoolean3,
    description: "Whether the chat is archived (ZARCHIVED)."
  },
  hidden: {
    ...nullableBoolean3,
    description: "Whether WhatsApp hides the chat from its list (ZHIDDEN)."
  },
  removed: {
    ...nullableBoolean3,
    description: "Whether the chat was removed from the list (ZREMOVED)."
  },
  flags: {
    ...nullableInteger6,
    description: "WhatsApp\u2019s undocumented bit flags of the chat (ZFLAGS)."
  },
  unreadCount: {
    ...nullableInteger6,
    description: "Unread messages, as the badge shows them (ZUNREADCOUNT)."
  },
  messageCounter: {
    ...nullableInteger6,
    description: "WhatsApp\u2019s running message count of the chat (ZMESSAGECOUNTER)."
  },
  identityVerificationState: {
    ...nullableInteger6,
    description: "WhatsApp\u2019s code for whether the person\u2019s security code was verified (ZIDENTITYVERIFICATIONSTATE)."
  },
  identityVerificationEpoch: {
    ...nullableInteger6,
    description: "Which of the person\u2019s identity keys the verification state is for (ZIDENTITYVERIFICATIONEPOCH)."
  },
  lastMessageDate: {
    ...nullableInstant6,
    description: "When the chat\u2019s last message was sent, UTC (ZLASTMESSAGEDATE)."
  },
  lastMessageText: {
    ...nullableText9,
    description: "Despite its name, WhatsApp\u2019s state of the chat as it stores it (ZLASTMESSAGETEXT): a protobuf in base64 holding, among others, the last message\u2019s stanza ID (field 13) and pinned messages with their pin\u2019s expiry (fields 31 and 34)."
  },
  locationSharingEndDate: {
    ...nullableInstant6,
    description: "When the account\u2019s live location sharing in the chat ends (ZLOCATIONSHARINGENDDATE)."
  },
  savedInput: {
    ...nullableText9,
    description: "An unsent draft typed into the chat (ZSAVEDINPUT)."
  },
  groupCreationDate: {
    ...nullableInstant6,
    description: `When the group was created (ZWAGROUPINFO.ZCREATIONDATE); ${groupOnly}`
  },
  groupCreatorJid: {
    ...nullableJid3,
    description: `Who created the group (ZCREATORJID); ${groupOnly}`
  },
  groupOwnerJid: {
    ...nullableJid3,
    description: `The group\u2019s owner (ZOWNERJID); ${groupOnly}`
  },
  groupSubjectTimestamp: {
    ...nullableInstant6,
    description: `When the group subject was last set (ZSUBJECTTIMESTAMP); ${groupOnly}`
  },
  groupSubjectOwnerJid: {
    ...nullableJid3,
    description: `Who last set the group subject (ZSUBJECTOWNERJID); ${groupOnly}`
  },
  groupPictureId: {
    ...nullableText9,
    description: `The group picture\u2019s ID (ZPICTUREID); ${groupOnly}`
  },
  groupPicturePath: {
    ...nullableText9,
    description: `Where WhatsApp keeps the group picture, relative to its container (ZPICTUREPATH); ${groupOnly}`
  },
  groupSourceJid: {
    ...nullableJid3,
    description: `The group this one came from, such as a community\u2019s (ZSOURCEJID); ${groupOnly}`
  },
  groupState: {
    ...nullableInteger6,
    description: `WhatsApp\u2019s undocumented code for the account\u2019s state in the group (ZSTATE); ${groupOnly}`
  }
};
var ChatsStream = class extends WhatsAppStream {
  name = "chats";
  store = "chatStorage";
  primaryKey = ["jid"];
  jsonSchema = {
    type: "object",
    description: "One record per WhatsApp chat: a person, a group, a channel, a broadcast list or a contact\u2019s statuses, with the group\u2019s details for a group. Primary key jid. WhatsApp keeps a second, empty session for a few JIDs; the first stands for both.",
    properties: properties12,
    required: Object.keys(properties12)
  };
  rows(scan) {
    return scan.chatStorage.chats;
  }
  record({ group, ...chat }) {
    return {
      ...chat,
      groupCreationDate: group?.creationDate ?? null,
      groupCreatorJid: group?.creatorJid ?? null,
      groupOwnerJid: group?.ownerJid ?? null,
      groupSubjectTimestamp: group?.subjectTimestamp ?? null,
      groupSubjectOwnerJid: group?.subjectOwnerJid ?? null,
      groupPictureId: group?.pictureId ?? null,
      groupPicturePath: group?.picturePath ?? null,
      groupSourceJid: group?.sourceJid ?? null,
      groupState: group?.state ?? null
    };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/contacts-stream.js
var { text: text8, nullableJid: nullableJid4, nullableText: nullableText10, nullableInteger: nullableInteger7, nullableInstant: nullableInstant7 } = whatsappFields;
var column = (what, name) => `${what} (${name}).`;
var properties13 = {
  uniqueId: {
    ...text8,
    minLength: 1,
    description: column("WhatsApp\u2019s ID of this record; the primary key", "ZUNIQUEID")
  },
  whatsappId: {
    ...nullableJid4,
    description: column("The person\u2019s WhatsApp JID by phone number", "ZWHATSAPPID")
  },
  lid: {
    ...nullableJid4,
    description: column("The person\u2019s LID; refers to users.lid", "ZLID")
  },
  interopJid: {
    ...nullableJid4,
    description: column("The person\u2019s JID on another messaging service", "ZINTEROPJID")
  },
  identifier: {
    ...nullableText10,
    description: column("The macOS Contacts identifier of the card", "ZIDENTIFIER")
  },
  fullName: {
    ...nullableText10,
    description: column("The full name", "ZFULLNAME")
  },
  givenName: {
    ...nullableText10,
    description: column("The given name", "ZGIVENNAME")
  },
  lastName: {
    ...nullableText10,
    description: column("The last name", "ZLASTNAME")
  },
  businessName: {
    ...nullableText10,
    description: column("The business name", "ZBUSINESSNAME")
  },
  highlightedName: {
    ...nullableText10,
    description: column("The name WhatsApp highlights", "ZHIGHLIGHTEDNAME")
  },
  username: {
    ...nullableText10,
    description: column("The person\u2019s WhatsApp username", "ZUSERNAME")
  },
  phoneNumber: {
    ...nullableText10,
    description: column("The phone number, digits only", "ZPHONENUMBER")
  },
  localizedPhoneNumber: {
    ...nullableText10,
    description: column("The phone number as the card writes it", "ZLOCALIZEDPHONENUMBER")
  },
  phoneNumberLabel: {
    ...nullableText10,
    description: column("The card\u2019s label for the number", "ZPHONENUMBERLABEL")
  },
  phoneStatus: {
    ...nullableInteger7,
    description: column("WhatsApp\u2019s undocumented code for the number", "ZPHONESTATUS")
  },
  aboutText: {
    ...nullableText10,
    description: column("The person\u2019s About text", "ZABOUTTEXT")
  },
  aboutEmoji: {
    ...nullableText10,
    description: column("The emoji of the person\u2019s About", "ZABOUTEMOJI")
  },
  aboutTimestamp: {
    ...nullableInstant7,
    description: column("When the person set their About, UTC", "ZABOUTTIMESTAMP")
  },
  aboutExpirationTimestamp: {
    ...nullableInstant7,
    description: column("When the person\u2019s About expires, UTC", "ZABOUTEXPIRATIONTIMESTAMP")
  },
  notes: { ...nullableText10, description: column("The card\u2019s notes", "ZNOTES") },
  disappearingModeDuration: {
    ...nullableInteger7,
    description: column("The person\u2019s default disappearing-message timer in seconds; 0 when off", "ZDISAPPEARINGMODEDURATION")
  },
  disappearingModeTimestamp: {
    ...nullableInstant7,
    description: column("When that timer was set, UTC", "ZDISAPPEARINGMODETIMESTAMP")
  },
  source: {
    ...nullableInteger7,
    description: column("WhatsApp\u2019s undocumented code for where the record came from", "ZSOURCE")
  },
  syncPolicy: {
    ...nullableInteger7,
    description: column("WhatsApp\u2019s undocumented sync policy code", "ZSYNCPOLICY")
  },
  lastUpdated: {
    ...nullableInstant7,
    description: column("When WhatsApp last updated the record, UTC", "ZLASTUPDATED")
  }
};
var ContactsStream = class extends WhatsAppStream {
  name = "contacts";
  store = "contacts";
  primaryKey = ["uniqueId"];
  jsonSchema = {
    type: "object",
    description: "One record per phone number in the Mac\u2019s address book that WhatsApp found on WhatsApp (ContactsV2.sqlite\u2019s ZWAADDRESSBOOKCONTACT). Primary key uniqueId. Not narrowed by an import\u2019s chats or dates.",
    properties: properties13,
    required: Object.keys(properties13)
  };
  rows(scan) {
    return scan.contacts.contacts();
  }
  record(contact) {
    return { ...contact };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/disappearing-modes-stream.js
var { jid: jid11, integer: integer6, nullableText: nullableText11 } = whatsappFields;
var properties14 = {
  lid: {
    ...jid11,
    description: "The account, by LID; refers to users.lid; the primary key."
  },
  durationSeconds: {
    ...integer6,
    minimum: 0,
    description: "The account\u2019s default timer for messages in new chats, in seconds: 0 off, 86400 a day, 604800 a week, 7776000 ninety days."
  },
  setAt: {
    ...nullableText11,
    format: "date-time",
    precision: 0,
    description: "When the account set it, UTC; NULL when WhatsApp has no time."
  }
};
var DisappearingModesStream = class extends WhatsAppStream {
  name = "disappearingModes";
  store = "localKeyValue";
  primaryKey = ["lid"];
  jsonSchema = {
    type: "object",
    description: "One record per account whose default disappearing-message timer WhatsApp knows, this account\u2019s own among them (LocalKeyValue.sqlite\u2019s disappearing-mode). Primary key lid. Not narrowed by an import\u2019s chats or dates.",
    properties: properties14,
    required: Object.keys(properties14)
  };
  rows(scan) {
    return scan.localKeyValue.disappearingModes();
  }
  record(mode) {
    return { ...mode };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/favorite-stickers-stream.js
var { text: text9, nullableInstant: nullableInstant8 } = whatsappFields;
var properties15 = {
  fileHash: {
    ...text9,
    minLength: 1,
    description: "The sticker; refers to stickers.fileHash; the primary key."
  },
  favoritedAt: {
    ...nullableInstant8,
    description: "When the account favorited it, UTC."
  }
};
var FavoriteStickersStream = class extends WhatsAppStream {
  name = "favoriteStickers";
  store = "backedUpKeyValue";
  primaryKey = ["fileHash"];
  jsonSchema = {
    type: "object",
    description: "One record per sticker the account favorited (BackedUpKeyValue.sqlite\u2019s fs.v2). Primary key fileHash. Not narrowed by an import\u2019s chats or dates.",
    properties: properties15,
    required: Object.keys(properties15)
  };
  rows(scan) {
    return scan.backedUpKeyValue.favoriteStickers();
  }
  record(sticker2) {
    return { ...sticker2 };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/group-members-changes-stream.js
var { jid: jid12, text: text10, integer: integer7, instant: instant3 } = whatsappFields;
var properties16 = {
  groupJid: {
    ...jid12,
    description: "The group; refers to chats.jid (ZGROUPJID)."
  },
  changeDate: {
    ...instant3,
    description: "When the members changed, UTC (ZCHANGEDATE)."
  },
  changeType: {
    ...integer7,
    description: "WhatsApp\u2019s undocumented code for the change (ZCHANGETYPE)."
  },
  memberJids: {
    ...text10,
    minLength: 1,
    description: "The members the change is about, as WhatsApp lists them (ZMEMBERJIDS)."
  }
};
var GroupMembersChangesStream = class extends WhatsAppStream {
  name = "groupMembersChanges";
  store = "chatStorage";
  primaryKey = ["groupJid", "changeDate", "changeType", "memberJids"];
  jsonSchema = {
    type: "object",
    description: "One record per change to a group\u2019s members WhatsApp keeps (ZWAGROUPMEMBERSCHANGE). Primary key groupJid, changeDate, changeType, memberJids.",
    properties: properties16,
    required: Object.keys(properties16)
  };
  rows(scan) {
    return scan.chatStorage.groupMembersChanges;
  }
  record(change) {
    return { ...change };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/group-members-stream.js
var { jid: jid13, nullableText: nullableText12, nullableInteger: nullableInteger8, nullableBoolean: nullableBoolean4 } = whatsappFields;
var properties17 = {
  groupJid: {
    ...jid13,
    description: "The group; refers to chats.jid."
  },
  memberJid: {
    ...jid13,
    description: "The member, as <LID>@lid, <number>@s.whatsapp.net or a bot\u2019s \u2026@bot (ZMEMBERJID)."
  },
  contactName: {
    ...nullableText12,
    description: "The name WhatsApp shows for the member (ZCONTACTNAME)."
  },
  firstName: {
    ...nullableText12,
    description: "The member\u2019s first name from the address book (ZFIRSTNAME)."
  },
  contactIdentifier: {
    ...nullableText12,
    description: "The member\u2019s macOS Contacts identifier (ZCONTACTIDENTIFIER)."
  },
  contactAbId: {
    ...nullableInteger8,
    description: "The member\u2019s address book record number (ZCONTACTABID)."
  },
  isActive: {
    ...nullableBoolean4,
    description: "Whether the person is still in the group (ZISACTIVE)."
  },
  isAdmin: {
    ...nullableBoolean4,
    description: "Whether the person is a group admin (ZISADMIN)."
  }
};
var GroupMembersStream = class extends WhatsAppStream {
  name = "groupMembers";
  store = "chatStorage";
  primaryKey = ["groupJid", "memberJid"];
  jsonSchema = {
    type: "object",
    description: "One record per person WhatsApp lists for a group, including those who left (isActive false). Primary key groupJid, memberJid.",
    properties: properties17,
    required: Object.keys(properties17)
  };
  rows(scan) {
    return scan.chatStorage.groupMembers;
  }
  record(member) {
    return { ...member };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/linked-profiles-stream.js
var { jid: jid14, text: text11, nullableText: nullableText13 } = whatsappFields;
var properties18 = {
  lid: { ...jid14, description: "The person, by LID; refers to users.lid." },
  type: {
    ...text11,
    minLength: 1,
    description: "The service, such as INSTAGRAM."
  },
  username: { ...nullableText13, description: "Their name on it." },
  url: { ...nullableText13, description: "Their profile\u2019s address on it." }
};
var LinkedProfilesStream = class extends WhatsAppStream {
  name = "linkedProfiles";
  store = "localKeyValue";
  primaryKey = ["lid", "type"];
  jsonSchema = {
    type: "object",
    description: "One record per account on another service a person links to their WhatsApp profile (LocalKeyValue.sqlite\u2019s linked-profiles). Primary key lid, type. Not narrowed by an import\u2019s chats or dates.",
    properties: properties18,
    required: Object.keys(properties18)
  };
  rows(scan) {
    return scan.localKeyValue.linkedProfiles();
  }
  record(profile2) {
    return { ...profile2 };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/message-associations-stream.js
var { jid: jid15, text: text12, integer: integer8 } = whatsappFields;
var properties19 = {
  chatJid: {
    ...jid15,
    description: "The chat both messages are in; refers to chats.jid."
  },
  stanzaId: {
    ...text12,
    minLength: 1,
    description: "The message shown as part of another; with chatJid, refers to messages.stanzaId."
  },
  type: {
    ...integer8,
    description: "WhatsApp\u2019s undocumented kind of link: 1 joins a photo or video to its album; 5, 10 and 12 link other images and videos to their parent."
  },
  parentStanzaId: {
    ...text12,
    minLength: 1,
    description: "The message it is part of, such as the album."
  },
  sort: {
    ...integer8,
    description: "WhatsApp\u2019s order of the message in its chat."
  }
};
var MessageAssociationsStream = class extends WhatsAppStream {
  name = "messageAssociations";
  store = "messageAssociations";
  primaryKey = ["chatJid", "stanzaId", "type"];
  jsonSchema = {
    type: "object",
    description: "One record per message WhatsApp shows as part of another of the same chat, such as a photo of an album (ExtChatDB\u2019s message_parent_association). Primary key chatJid, stanzaId, type, as the table keys it.",
    properties: properties19,
    required: Object.keys(properties19)
  };
  rows(scan) {
    return scan.messageAssociations();
  }
  record(association) {
    return { ...association };
  }
};

// packages/sources/whatsapp/desktop/dist/message-key-fields.js
var { jid: jid16, boolean, text: text13 } = whatsappFields;
var messageKeyFields = {
  chatJid: {
    ...jid16,
    description: "The chat the message is in; refers to chats.jid."
  },
  messageIsFromMe: {
    ...boolean,
    description: "Whether this account sent the message; with chatJid and messageStanzaId, refers to messages."
  },
  messageStanzaId: {
    ...text13,
    minLength: 1,
    description: "The stanza ID its sender gave the message; with chatJid and messageIsFromMe, refers to messages."
  }
};
var messageKeyColumns = [
  "chatJid",
  "messageIsFromMe",
  "messageStanzaId"
];
function messageKeyRecord({ chatJid, isFromMe, stanzaId }) {
  return { chatJid, messageIsFromMe: isFromMe, messageStanzaId: stanzaId };
}

// packages/sources/whatsapp/desktop/dist/streams/message-data-items-stream.js
var { integer: integer9, nullableInteger: nullableInteger9, nullableText: nullableText14, nullableJid: nullableJid5, nullableBoolean: nullableBoolean5, nullableInstant: nullableInstant9 } = whatsappFields;
var column2 = (what, name) => `${what} (ZWAMESSAGEDATAITEM.${name}).`;
var properties20 = {
  ...messageKeyFields,
  index: {
    ...integer9,
    minimum: 0,
    description: column2("The item\u2019s place among the message\u2019s items", "ZINDEX")
  },
  type: {
    ...nullableInteger9,
    description: column2("WhatsApp\u2019s item kind; 0, a link, is the only one seen", "ZTYPE")
  },
  date: {
    ...nullableInstant9,
    description: column2("WhatsApp\u2019s date of the item, UTC", "ZDATE")
  },
  content1: { ...nullableText14, description: column2("The link", "ZCONTENT1") },
  content2: {
    ...nullableText14,
    description: column2("WhatsApp\u2019s second content value", "ZCONTENT2")
  },
  title: {
    ...nullableText14,
    description: column2("The linked page\u2019s title", "ZTITLE")
  },
  summary: {
    ...nullableText14,
    description: column2("The linked page\u2019s description", "ZSUMMARY")
  },
  matchedText: {
    ...nullableText14,
    description: column2("The text WhatsApp matched as the link", "ZMATCHEDTEXT")
  },
  sectionId: {
    ...nullableText14,
    description: column2("The month WhatsApp lists the link under, YYYY-MM", "ZSECTIONID")
  },
  senderJid: {
    ...nullableJid5,
    description: column2("WhatsApp\u2019s sender value", "ZSENDERJID")
  },
  thumbnailPath: {
    ...nullableText14,
    description: column2("Where WhatsApp keeps the link\u2019s thumbnail", "ZTHUMBNAILPATH")
  },
  ownsThumbnail: {
    ...nullableBoolean5,
    description: column2("Whether the item owns that thumbnail", "ZOWNSTHUMBNAIL")
  }
};
var MessageDataItemsStream = class extends WhatsAppStream {
  name = "messageDataItems";
  store = "chatStorage";
  primaryKey = [...messageKeyColumns, "index"];
  jsonSchema = {
    type: "object",
    description: "One record per link WhatsApp found in a message, as its chat\u2019s Links list shows them, with the linked page\u2019s title and description. Primary key chatJid, messageIsFromMe, messageStanzaId, index.",
    properties: properties20,
    required: Object.keys(properties20)
  };
  rows(scan) {
    return scan.chatStorage.dataItems;
  }
  record({ chatJid, isFromMe, stanzaId, ...item }) {
    return { ...messageKeyRecord({ chatJid, isFromMe, stanzaId }), ...item };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/message-reaction-counts-stream.js
var { text: text14, integer: integer10 } = whatsappFields;
var properties21 = {
  ...messageKeyFields,
  emoji: { ...text14, minLength: 1, description: "The reaction." },
  count: {
    ...integer10,
    minimum: 0,
    description: "How many people reacted with it."
  }
};
var MessageReactionCountsStream = class extends WhatsAppStream {
  name = "messageReactionCounts";
  store = "chatStorage";
  primaryKey = [...messageKeyColumns, "emoji"];
  jsonSchema = {
    type: "object",
    description: "One record per emoji people reacted with to a channel post, which WhatsApp counts rather than naming who reacted; decoded from the post\u2019s receipt info. Primary key chatJid, messageIsFromMe, messageStanzaId, emoji.",
    properties: properties21,
    required: Object.keys(properties21)
  };
  rows(scan) {
    return scan.chatStorage.reactionCounts;
  }
  record({ message, item }) {
    return { ...messageKeyRecord(message), ...item };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/message-reactions-stream.js
var { text: text15, boolean: boolean2, nullableJid: nullableJid6, nullableText: nullableText15 } = whatsappFields;
var properties22 = {
  ...messageKeyFields,
  reactionStanzaId: {
    ...text15,
    minLength: 1,
    description: "The ID its sender gave the reaction."
  },
  senderJid: {
    ...nullableJid6,
    description: "Who reacted; NULL when this account did."
  },
  isFromMe: {
    ...boolean2,
    description: "Whether this account reacted."
  },
  emoji: {
    ...nullableText15,
    description: "The reaction; NULL when its sender withdrew it, which WhatsApp keeps."
  },
  reactedAt: {
    ...text15,
    format: "date-time",
    description: "When the reaction was sent, UTC to the millisecond."
  }
};
var MessageReactionsStream = class extends WhatsAppStream {
  name = "messageReactions";
  store = "chatStorage";
  primaryKey = [...messageKeyColumns, "reactionStanzaId"];
  jsonSchema = {
    type: "object",
    description: "One record per reaction to a message, decoded from the message\u2019s receipt info (ZWAMESSAGEINFO.ZRECEIPTINFO). Primary key chatJid, messageIsFromMe, messageStanzaId, reactionStanzaId. A channel post keeps counts instead; see messageReactionCounts.",
    properties: properties22,
    required: Object.keys(properties22)
  };
  rows(scan) {
    return scan.chatStorage.reactions;
  }
  record({ message, item: { stanzaId, ...reaction } }) {
    return {
      ...messageKeyRecord(message),
      reactionStanzaId: stanzaId,
      ...reaction
    };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/message-receipts-stream.js
var { jid: jid17, text: text16 } = whatsappFields;
var second2 = { ...text16, format: "date-time", precision: 0 };
var nullableSecond = { ...second2, type: ["string", "null"] };
var properties23 = {
  ...messageKeyFields,
  recipientJid: {
    ...jid17,
    description: "A device owner the message went to: the other person, a group member, or this account itself, whose other devices also acknowledge its messages."
  },
  deliveredAt: {
    ...nullableSecond,
    description: "When the recipient\u2019s device received the message, UTC to the second; NULL until it has."
  },
  readAt: {
    ...nullableSecond,
    description: "When the recipient read the message, UTC to the second; NULL until they have, or when they send no read receipts."
  },
  playedAt: {
    ...nullableSecond,
    description: "When the recipient played the voice note or video, UTC to the second; NULL until they have."
  }
};
var MessageReceiptsStream = class extends WhatsAppStream {
  name = "messageReceipts";
  store = "chatStorage";
  primaryKey = [...messageKeyColumns, "recipientJid"];
  jsonSchema = {
    type: "object",
    description: "One record per recipient WhatsApp holds receipts from for a message, decoded from the message\u2019s receipt info (ZWAMESSAGEINFO.ZRECEIPTINFO): WhatsApp keeps them for the messages this account sent and for some it received. Primary key chatJid, messageIsFromMe, messageStanzaId, recipientJid.",
    properties: properties23,
    required: Object.keys(properties23)
  };
  rows(scan) {
    return scan.chatStorage.receipts;
  }
  record({ message, item }) {
    return { ...messageKeyRecord(message), ...item };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/messages-stream.js
var { jid: jid18, nullableJid: nullableJid7, text: text17, boolean: boolean3, integer: integer11, nullableInteger: nullableInteger10, nullableNumber: nullableNumber4, nullableText: nullableText16, nullableBoolean: nullableBoolean6, nullableInstant: nullableInstant10, nullableBase64 } = whatsappFields;
var media = (what, column5) => `${what} (ZWAMEDIAITEM.${column5}); NULL when not stored.`;
var properties24 = {
  chatJid: {
    ...jid18,
    description: "The chat the message is in; refers to chats.jid."
  },
  isFromMe: {
    ...boolean3,
    description: "Whether this account sent the message (ZISFROMME)."
  },
  stanzaId: {
    ...text17,
    minLength: 1,
    description: "The ID its sender gave the message (ZSTANZAID); with chatJid and isFromMe, the primary key, as WhatsApp keys a message."
  },
  senderJid: {
    ...nullableJid7,
    description: "Who sent the message: the group member for a group message, the person for a message from one; NULL when this account sent it or WhatsApp records no person, as for a group notice or a channel post."
  },
  fromJid: {
    ...nullableJid7,
    description: "The JID WhatsApp records the message as from (ZFROMJID): the person, or the group, channel or broadcast for messages there; NULL on this account\u2019s messages."
  },
  toJid: {
    ...nullableJid7,
    description: "The JID WhatsApp records the message as to (ZTOJID); set on this account\u2019s messages."
  },
  groupMemberJid: {
    ...nullableJid7,
    description: "The group member who sent the message (ZGROUPMEMBER \u2192 ZWAGROUPMEMBER.ZMEMBERJID); NULL outside groups and for group notices."
  },
  pushName: {
    ...nullableText16,
    description: "The name the sender gave WhatsApp when sending (ZPUSHNAME)."
  },
  messageDate: {
    ...nullableInstant10,
    description: "When the message was sent, UTC (ZMESSAGEDATE)."
  },
  sentDate: {
    ...nullableInstant10,
    description: "WhatsApp\u2019s sent date, UTC (ZSENTDATE); set on few messages."
  },
  messageType: {
    ...integer11,
    description: "WhatsApp\u2019s message kind (ZMESSAGETYPE), seen as: 0 text, 1 image, 2 video, 3 audio or voice note, 4 contact card, 5 location, 6 group notice, 7 link, 8 document, 14 a message deleted for everyone, which WhatsApp keeps with its content removed (in a group, text may name the admin who deleted it), 15 sticker. An edit rewrites the message in place. WhatsApp documents none of them; other codes stay numbers."
  },
  groupEventType: {
    ...nullableInteger10,
    description: "WhatsApp\u2019s undocumented code for what a notice says (ZGROUPEVENTTYPE); 2 on ordinary messages."
  },
  messageStatus: {
    ...nullableInteger10,
    description: "WhatsApp\u2019s delivery state (ZMESSAGESTATUS), seen as: 6 delivered, 8 read, 5 played (voice notes)."
  },
  messageErrorStatus: {
    ...nullableInteger10,
    description: "WhatsApp\u2019s undocumented failure code (ZMESSAGEERRORSTATUS)."
  },
  flags: {
    ...nullableInteger10,
    description: "WhatsApp\u2019s undocumented bit flags of the message (ZFLAGS)."
  },
  starred: {
    ...nullableBoolean6,
    description: "Whether the message is starred (ZSTARRED)."
  },
  sort: {
    ...nullableInteger10,
    description: "WhatsApp\u2019s order of the message in its chat (ZSORT)."
  },
  text: {
    ...nullableText16,
    description: "The message text, a link message\u2019s text with its URL, a document\u2019s caption, or a notice\u2019s text (ZTEXT); NULL on images and videos, whose caption is title."
  },
  childMessagesDeliveredCount: {
    ...nullableInteger10,
    description: "For a broadcast list message, how many recipients received it (ZCHILDMESSAGESDELIVEREDCOUNT)."
  },
  childMessagesReadCount: {
    ...nullableInteger10,
    description: "For a broadcast list message, how many recipients read it (ZCHILDMESSAGESREADCOUNT)."
  },
  childMessagesPlayedCount: {
    ...nullableInteger10,
    description: "For a broadcast list message, how many recipients played it (ZCHILDMESSAGESPLAYEDCOUNT)."
  },
  filteredRecipientCount: {
    ...nullableInteger10,
    description: "For a broadcast list message, how many recipients WhatsApp did not send it to (ZFILTEREDRECIPIENTCOUNT)."
  },
  parentStanzaId: {
    ...nullableText16,
    description: "The stanza ID of the message this one belongs to in ChatStorage (ZPARENTMESSAGE); see messageAssociations for albums."
  },
  quotedStanzaId: {
    ...nullableText16,
    description: "For a reply, the stanza ID of the message it quotes, in the same chat; decoded from metadata."
  },
  quotedSenderJid: {
    ...nullableJid7,
    description: "For a reply, who sent the quoted message, as the reply names them (often a LID where the quoted message holds a phone JID); decoded from metadata."
  },
  mediaLocalPath: {
    ...nullableText16,
    description: media("Where WhatsApp keeps the media file, relative to the Message folder of its container", "ZMEDIALOCALPATH")
  },
  mediaAvailableLocally: {
    ...boolean3,
    description: "Whether the file at mediaLocalPath was on this Mac when the record was read; most media is never downloaded to it. File bytes are exported only when true."
  },
  thumbnailLocalPath: {
    ...nullableText16,
    description: media("Where WhatsApp keeps the media\u2019s thumbnail, relative to the Message folder", "ZTHUMBNAILLOCALPATH")
  },
  mediaUrl: {
    ...nullableText16,
    description: media("The encrypted file on WhatsApp\u2019s servers, or a link message\u2019s URL", "ZMEDIAURL")
  },
  mediaUrlDate: {
    ...nullableInstant10,
    description: media("When mediaUrl was issued", "ZMEDIAURLDATE")
  },
  fileSize: {
    ...nullableInteger10,
    description: media("The media file\u2019s size in bytes", "ZFILESIZE")
  },
  movieDuration: {
    ...nullableInteger10,
    description: media("A video\u2019s or audio\u2019s length in seconds", "ZMOVIEDURATION")
  },
  aspectRatio: {
    ...nullableNumber4,
    description: media("The media\u2019s aspect ratio", "ZASPECTRATIO")
  },
  title: {
    ...nullableText16,
    description: media("A link\u2019s or document\u2019s title, or an image\u2019s or video\u2019s caption", "ZTITLE")
  },
  authorName: {
    ...nullableText16,
    description: media("A document\u2019s file name", "ZAUTHORNAME")
  },
  collectionName: {
    ...nullableText16,
    description: media("WhatsApp\u2019s collection name", "ZCOLLECTIONNAME")
  },
  vCardName: {
    ...nullableText16,
    description: media("A contact card\u2019s name; for a media file, the file\u2019s SHA-256 in base64", "ZVCARDNAME")
  },
  vCardString: {
    ...nullableText16,
    description: media("A contact card\u2019s vCard; for a media file, its MIME type", "ZVCARDSTRING")
  },
  latitude: {
    ...nullableNumber4,
    description: media("A location\u2019s latitude; for an image, video or link preview, its height in pixels", "ZLATITUDE")
  },
  longitude: {
    ...nullableNumber4,
    description: media("A location\u2019s longitude; for an image, video or link preview, its width in pixels", "ZLONGITUDE")
  },
  hAccuracy: {
    ...nullableNumber4,
    description: media("A location\u2019s accuracy in meters", "ZHACCURACY")
  },
  mediaOrigin: {
    ...nullableInteger10,
    description: media("WhatsApp\u2019s undocumented media origin code", "ZMEDIAORIGIN")
  },
  cloudStatus: {
    ...nullableInteger10,
    description: media("WhatsApp\u2019s undocumented cloud status code", "ZCLOUDSTATUS")
  },
  metadata: {
    ...nullableBase64,
    description: "The message\u2019s metadata as WhatsApp stores it (ZWAMEDIAITEM.ZMETADATA), base64: a protobuf with no published schema, holding the reply context, link previews, list menus and a per-message secret."
  },
  receiptInfo: {
    ...nullableBase64,
    description: "The message\u2019s receipts and reactions as WhatsApp stores them (ZWAMESSAGEINFO.ZRECEIPTINFO), base64; messageReceipts and messageReactions decode them."
  }
};
var person = (jid23) => jid23 !== null && /@(s\.whatsapp\.net|lid)$/.test(jid23) ? jid23 : null;
var MessagesStream = class extends WhatsAppStream {
  name = "messages";
  store = "chatStorage";
  primaryKey = ["chatJid", "isFromMe", "stanzaId"];
  supportsFileTransfer = true;
  jsonSchema = {
    type: "object",
    description: "One record per WhatsApp message in a chat this Mac holds, with its media item: the file, link preview, contact card or place it carries. Primary key chatJid, isFromMe, stanzaId. WhatsApp writes the store only while it runs, so a message reaches it once WhatsApp has run since. A second copy of a message stands as the first; a message WhatsApp keeps with no chat belongs to no conversation and is not read.",
    properties: properties24,
    required: Object.keys(properties24)
  };
  rows(scan) {
    return scan.chatStorage.messages;
  }
  record({ media: item, quoted, receiptInfo, groupMemberJid, fromJid, ...message }) {
    return {
      ...message,
      senderJid: message.isFromMe ? null : groupMemberJid ?? person(fromJid),
      fromJid,
      groupMemberJid,
      quotedStanzaId: quoted?.stanzaId ?? null,
      quotedSenderJid: quoted?.senderJid ?? null,
      mediaLocalPath: item?.mediaLocalPath ?? null,
      mediaAvailableLocally: (item?.mediaFile ?? null) !== null,
      thumbnailLocalPath: item?.thumbnailLocalPath ?? null,
      mediaUrl: item?.mediaUrl ?? null,
      mediaUrlDate: item?.mediaUrlDate ?? null,
      fileSize: item?.fileSize ?? null,
      movieDuration: item?.movieDuration ?? null,
      aspectRatio: item?.aspectRatio ?? null,
      title: item?.title ?? null,
      authorName: item?.authorName ?? null,
      collectionName: item?.collectionName ?? null,
      vCardName: item?.vCardName ?? null,
      vCardString: item?.vCardString ?? null,
      latitude: item?.latitude ?? null,
      longitude: item?.longitude ?? null,
      hAccuracy: item?.hAccuracy ?? null,
      mediaOrigin: item?.mediaOrigin ?? null,
      cloudStatus: item?.cloudStatus ?? null,
      metadata: base64(item?.metadata ?? null),
      receiptInfo: base64(receiptInfo)
    };
  }
  // The original file, not a staged copy: WhatsApp media reaches gigabytes
  // and readers only read it.
  file({ mediaLocalPath, mediaAvailableLocally }, scan) {
    return mediaAvailableLocally && mediaLocalPath !== null ? messageMediaFile(scan.container, mediaLocalPath) : null;
  }
};

// packages/sources/whatsapp/desktop/dist/streams/privacy-settings-stream.js
var { text: text18 } = whatsappFields;
var properties25 = {
  category: {
    ...text18,
    minLength: 1,
    description: "What the setting covers, as WhatsApp names it: last (last seen), online, profile (photo), status (About), groupadd, calladd, messages, stickers, linked_profiles, cover_photo, defense; the primary key."
  },
  value: {
    ...text18,
    description: "Who it allows, as WhatsApp names it: all, contacts, none, match_last_seen, or on or off."
  }
};
var PrivacySettingsStream = class extends WhatsAppStream {
  name = "privacySettings";
  store = "localKeyValue";
  primaryKey = ["category"];
  jsonSchema = {
    type: "object",
    description: "One record per privacy setting of this account, as WhatsApp last fetched them (LocalKeyValue.sqlite\u2019s privacy-settings-values). Read receipts are a preference WhatsApp keeps elsewhere and are not here. Primary key category. Not narrowed by an import\u2019s chats or dates.",
    properties: properties25,
    required: Object.keys(properties25)
  };
  rows(scan) {
    return scan.localKeyValue.privacySettings();
  }
  record(setting) {
    return { ...setting };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/profile-pictures-stream.js
var { jid: jid19, boolean: boolean4, nullableText: nullableText17, nullableInstant: nullableInstant11 } = whatsappFields;
var properties26 = {
  jid: {
    ...jid19,
    description: "The person or group (ZJID); the primary key."
  },
  pictureId: {
    ...nullableText17,
    description: "The picture\u2019s ID; a new one marks a new picture (ZPICTUREID)."
  },
  path: {
    ...nullableText17,
    description: "Where WhatsApp keeps the picture, relative to its container; the file on disk adds .thumb (ZPATH)."
  },
  availableLocally: {
    ...boolean4,
    description: "Whether the picture\u2019s thumbnail was on this Mac when the record was read. File bytes are exported only when true."
  },
  requestDate: {
    ...nullableInstant11,
    description: "When WhatsApp last fetched the picture, UTC (ZREQUESTDATE)."
  }
};
var ProfilePicturesStream = class extends WhatsAppStream {
  name = "profilePictures";
  store = "chatStorage";
  primaryKey = ["jid"];
  supportsFileTransfer = true;
  jsonSchema = {
    type: "object",
    description: "One record per person or group whose profile picture WhatsApp has looked up (ZWAPROFILEPICTUREITEM), with the thumbnail it keeps, the only copy on this Mac. Primary key jid. Not narrowed by an import\u2019s chats or dates.",
    properties: properties26,
    required: Object.keys(properties26)
  };
  rows(scan) {
    return scan.chatStorage.profilePictures;
  }
  record({ file, ...picture }) {
    return { ...picture, availableLocally: file !== null };
  }
  file({ path, availableLocally }, scan) {
    return availableLocally && path !== null ? profilePictureFile(scan.container, path) : null;
  }
};

// packages/sources/whatsapp/desktop/dist/streams/push-names-stream.js
var { jid: jid20, nullableText: nullableText18 } = whatsappFields;
var properties27 = {
  jid: { ...jid20, description: "The person (ZJID); the primary key." },
  pushName: {
    ...nullableText18,
    description: "The name the person gave WhatsApp, which it shows beside their number when they are not in the address book (ZPUSHNAME)."
  }
};
var PushNamesStream = class extends WhatsAppStream {
  name = "pushNames";
  store = "chatStorage";
  primaryKey = ["jid"];
  jsonSchema = {
    type: "object",
    description: "One record per person whose own WhatsApp name this account has seen (ZWAPROFILEPUSHNAME). Primary key jid. Not narrowed by an import\u2019s chats or dates.",
    properties: properties27,
    required: Object.keys(properties27)
  };
  rows(scan) {
    return scan.chatStorage.pushNames;
  }
  record(name) {
    return { ...name };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/recent-stickers-stream.js
var { text: text19, integer: integer12, nullableInteger: nullableInteger11, nullableNumber: nullableNumber5 } = whatsappFields;
var properties28 = {
  fileHash: {
    ...text19,
    minLength: 1,
    description: "The sticker; refers to stickers.fileHash; the primary key."
  },
  position: {
    ...integer12,
    minimum: 0,
    description: "Its place in the picker\u2019s recent list, by score."
  },
  score: {
    ...nullableNumber5,
    description: "WhatsApp\u2019s ranking score for it."
  },
  lastUsed: {
    ...nullableInteger11,
    description: "When the account last sent it, in Unix milliseconds; 0 or 1 where WhatsApp keeps no time."
  }
};
var RecentStickersStream = class extends WhatsAppStream {
  name = "recentStickers";
  store = "backedUpKeyValue";
  primaryKey = ["fileHash"];
  jsonSchema = {
    type: "object",
    description: "One record per sticker in the picker\u2019s recent list (BackedUpKeyValue.sqlite\u2019s rs.v2). Primary key fileHash. Not narrowed by an import\u2019s chats or dates.",
    properties: properties28,
    required: Object.keys(properties28)
  };
  rows(scan) {
    return scan.backedUpKeyValue.recentStickers();
  }
  record(sticker2) {
    return { ...sticker2 };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/statuses-stream.js
var { jid: jid21, text: text20, integer: integer13, boolean: boolean5, nullableInteger: nullableInteger12, nullableText: nullableText19, nullableBoolean: nullableBoolean7 } = whatsappFields;
var instant4 = { ...text20, format: "date-time" };
var nullableInstant12 = { ...nullableText19, format: "date-time" };
var column3 = (what, name) => `${what} (${name}).`;
var marginMs = 36e5;
var properties29 = {
  senderJid: {
    ...jid21,
    description: column3("Who posted the status; status_me for the account\u2019s own", "status.sender_user_jid")
  },
  uuid: {
    ...text20,
    minLength: 1,
    description: column3("The status\u2019s ID; with senderJid, the primary key", "status.uuid")
  },
  type: {
    ...integer13,
    description: column3("WhatsApp\u2019s undocumented kind, seen as 3 text, 4 photo, 5 video, 10 a link, whose text is its URL", "status.type")
  },
  sortId: {
    ...nullableInteger12,
    description: column3("Its place among the sender\u2019s statuses", "status.sort_id")
  },
  timestamp: {
    ...instant4,
    description: column3("When it was posted, UTC", "status.timestamp")
  },
  serverReceiptTimestamp: {
    ...nullableInstant12,
    description: column3("When WhatsApp\u2019s server took it, UTC", "server_receipt_timestamp")
  },
  receivedTimestamp: {
    ...nullableInstant12,
    description: column3("When this account received it, UTC", "received_timestamp")
  },
  text: {
    ...nullableText19,
    description: column3("The text, a photo\u2019s or video\u2019s caption, or a link post\u2019s URL", "status.text_data")
  },
  state: {
    ...nullableInteger12,
    description: column3("WhatsApp\u2019s undocumented state code; 5 and 6 once viewed", "status.state")
  },
  origin: {
    ...nullableInteger12,
    description: column3("WhatsApp\u2019s undocumented origin code", "status.origin")
  },
  flags: {
    ...nullableInteger12,
    description: column3("WhatsApp\u2019s undocumented bit flags", "status.flags")
  },
  isArchived: {
    ...nullableBoolean7,
    description: column3("Whether the account\u2019s own status is kept in its archive after it expired", "status.is_archived")
  },
  audienceType: {
    ...nullableInteger12,
    description: column3("WhatsApp\u2019s undocumented audience code", "status.audience_type")
  },
  url: {
    ...nullableText19,
    description: column3("A link post\u2019s link", "status_text.url")
  },
  pageTitle: {
    ...nullableText19,
    description: column3("The linked page\u2019s title", "status_text.page_title")
  },
  pageDescription: {
    ...nullableText19,
    description: column3("The linked page\u2019s description", "status_text.page_description")
  },
  fontStyle: {
    ...nullableInteger12,
    description: column3("A text status\u2019s font", "status_text.font_style")
  },
  textColor: {
    ...nullableInteger12,
    description: column3("A text status\u2019s text color, ARGB", "status_text.text_color")
  },
  backgroundColor: {
    ...nullableInteger12,
    description: column3("A text status\u2019s background color, ARGB", "status_text.background_color")
  },
  previewType: {
    ...nullableInteger12,
    description: column3("WhatsApp\u2019s undocumented link preview kind", "status_text.preview_type")
  },
  mimeType: {
    ...nullableText19,
    description: column3("The photo\u2019s or video\u2019s MIME type", "media_content.mime_type")
  },
  width: {
    ...nullableInteger12,
    description: column3("Width in pixels", "media_content.width")
  },
  height: {
    ...nullableInteger12,
    description: column3("Height in pixels", "media_content.height")
  },
  fileSize: {
    ...nullableInteger12,
    description: column3("The file\u2019s size in bytes", "media_content.file_size")
  },
  mediaDuration: {
    ...nullableInteger12,
    description: column3("A video\u2019s length in seconds", "media_content.media_duration")
  },
  accessibilityLabel: {
    ...nullableText19,
    description: column3("Its description for screen readers", "media_content.accessibility_label")
  },
  fileHash: {
    ...nullableText19,
    description: column3("The SHA-256 of the photo or video, base64", "media_content.file_hash")
  },
  filePath: {
    ...nullableText19,
    description: column3("Where WhatsApp keeps the file, relative to the Message folder of its container", "media_content.file_path")
  },
  mediaAvailableLocally: {
    ...boolean5,
    description: "Whether the file at filePath was on this Mac when the record was read. File bytes are exported only when true."
  }
};
var StatusesStream = class extends WhatsAppStream {
  name = "statuses";
  store = "statuses";
  primaryKey = ["senderJid", "uuid"];
  supportsFileTransfer = true;
  expiresBy = "timestamp";
  jsonSchema = {
    type: "object",
    description: "One record per status a contact or the account posted that WhatsApp held when read, with its text styling or link preview and its photo or video (statusDB/Status.sqlite). WhatsApp removes a contact\u2019s status a day after it is posted, without a deletion, so a status stays loaded after that; one that vanished within its day was withdrawn and is deleted. Primary key senderJid, uuid. Not narrowed by an import\u2019s chats or dates.",
    properties: properties29,
    required: Object.keys(properties29)
  };
  rows(scan) {
    return scan.statuses.statuses();
  }
  record({ file, ...status }) {
    return { ...status, mediaAvailableLocally: file !== null };
  }
  horizon(scan) {
    return new Date(scan.startedAt.getTime() - statusLifetimeMs + marginMs).toISOString();
  }
  file({ filePath, mediaAvailableLocally }, scan) {
    return mediaAvailableLocally && filePath !== null ? messageMediaFile(scan.container, filePath) : null;
  }
};

// packages/sources/whatsapp/desktop/dist/streams/sticker-packs-stream.js
var { text: text21, boolean: boolean6, nullableText: nullableText20, nullableInteger: nullableInteger13 } = whatsappFields;
var pack = (what, column5) => `${what} (ZWACDABSTRACTSTICKERPACK.${column5}).`;
var properties30 = {
  stickerPackId: {
    ...text21,
    minLength: 1,
    description: pack("The pack\u2019s ID in WhatsApp\u2019s catalog", "ZSTICKERPACKID")
  },
  inTray: {
    ...boolean6,
    description: "Whether the record is the pack in the picker\u2019s tray (true) or its listing in the sticker store (false); a pack can have both."
  },
  name: { ...nullableText20, description: pack("The pack\u2019s name", "ZNAME") },
  publisher: {
    ...nullableText20,
    description: pack("Who made it", "ZPUBLISHER")
  },
  description: {
    ...nullableText20,
    description: pack("The pack\u2019s description", "ZPACKDESCRIPTION")
  },
  fileSize: {
    ...nullableInteger13,
    description: pack("The pack\u2019s size in bytes", "ZFILESIZE")
  },
  stickerCount: {
    ...nullableInteger13,
    description: pack("How many stickers it has", "ZSTICKERCOUNT")
  },
  premiumStickerCount: {
    ...nullableInteger13,
    description: pack("How many of them are premium", "ZPREMIUMSTICKERCOUNT")
  },
  order: {
    ...nullableInteger13,
    description: pack("Its place in the tray or the store\u2019s list", "ZORDER")
  },
  flags: {
    ...nullableInteger13,
    description: "WhatsApp\u2019s undocumented bit flags of the pack, which differ between the tray (ZFLAGS) and the store (ZFLAGS1, where 2 is animated, 1 and 4 Lottie and 8 premium)."
  },
  imageDataHash: {
    ...nullableText20,
    description: pack("The catalog\u2019s hash of the pack\u2019s images", "ZIMAGEDATAHASH")
  },
  trayImageId: {
    ...nullableText20,
    description: pack("The tray icon\u2019s ID", "ZTRAYIMAGEID")
  },
  trayImageFilePath: {
    ...nullableText20,
    description: pack("Where WhatsApp keeps the tray icon, relative to its stickers folder", "ZTRAYIMAGEFILEPATH")
  },
  previewImageIds: {
    type: "array",
    items: text21,
    description: pack("The store\u2019s preview images, by ID", "ZPREVIEWIMAGEIDS")
  }
};
var StickerPacksStream = class extends WhatsAppStream {
  name = "stickerPacks";
  store = "stickers";
  primaryKey = ["stickerPackId", "inTray"];
  jsonSchema = {
    type: "object",
    description: "One record per sticker pack in the picker\u2019s tray, and one per pack in the copy WhatsApp keeps of its sticker store\u2019s catalog (Sticker.sqlite). Primary key stickerPackId, inTray. Not narrowed by an import\u2019s chats or dates.",
    properties: properties30,
    required: Object.keys(properties30)
  };
  rows(scan) {
    return scan.stickers.packs();
  }
  record(pack2) {
    return { ...pack2, previewImageIds: [...pack2.previewImageIds] };
  }
};

// packages/sources/whatsapp/desktop/dist/streams/stickers-stream.js
var { text: text22, boolean: boolean7, nullableText: nullableText21, nullableInteger: nullableInteger14 } = whatsappFields;
var sticker = (what, column5) => `${what} (ZWACDSTICKER.${column5}).`;
var properties31 = {
  fileHash: {
    ...text22,
    minLength: 1,
    description: sticker("The SHA-256 of the sticker file as WhatsApp\u2019s servers hold it, base64; the primary key", "ZFILEHASH")
  },
  stickerPackId: {
    ...nullableText21,
    description: "The tray pack it belongs to; refers to stickerPacks; NULL for a sticker the account favorited or sent, which belongs to no pack."
  },
  sort: {
    ...nullableInteger14,
    description: sticker("Its place in its pack", "ZSORT")
  },
  mimeType: {
    ...nullableText21,
    description: sticker("image/webp, or application/was for an animated WhatsApp sticker", "ZMIMETYPE")
  },
  width: {
    ...nullableInteger14,
    description: sticker("Width in pixels", "ZWIDTH")
  },
  height: {
    ...nullableInteger14,
    description: sticker("Height in pixels", "ZHEIGHT")
  },
  fileLength: {
    ...nullableInteger14,
    description: sticker("The file\u2019s size in bytes on WhatsApp\u2019s servers", "ZFILELENGTH")
  },
  flags: {
    ...nullableInteger14,
    description: sticker("WhatsApp\u2019s undocumented bit flags; bit 1 is animated", "ZFLAGS")
  },
  emojis: {
    ...nullableText21,
    description: sticker("The emoji it stands for, separated by spaces", "ZEMOJIS")
  },
  accessibilityText: {
    ...nullableText21,
    description: sticker("Its description for screen readers", "ZACCESSIBILITYTEXT")
  },
  imageHash: {
    ...nullableText21,
    description: sticker("WhatsApp\u2019s hash of the image", "ZIMAGEHASH")
  },
  relativeImagePath: {
    ...nullableText21,
    description: sticker("Where WhatsApp keeps the file, relative to its stickers folder", "ZRELATIVEIMAGEPATH")
  },
  availableLocally: {
    ...boolean7,
    description: "Whether the file at relativeImagePath was on this Mac when the record was read. File bytes are exported only when true."
  }
};
var StickersStream = class extends WhatsAppStream {
  name = "stickers";
  store = "stickers";
  primaryKey = ["fileHash"];
  supportsFileTransfer = true;
  jsonSchema = {
    type: "object",
    description: "One record per sticker WhatsApp keeps: those of the tray\u2019s packs, and those the account favorited or sent (see favoriteStickers and recentStickers). Primary key fileHash. Not narrowed by an import\u2019s chats or dates.",
    properties: properties31,
    required: Object.keys(properties31)
  };
  rows(scan) {
    return scan.stickers.stickers();
  }
  record({ file, ...row }) {
    return { ...row, availableLocally: file !== null };
  }
  file({ relativeImagePath, availableLocally }, scan) {
    return availableLocally && relativeImagePath !== null ? stickerFile(scan.container, relativeImagePath) : null;
  }
};

// packages/sources/whatsapp/desktop/dist/streams/users-stream.js
var { jid: jid22, nullableText: nullableText22, nullableInteger: nullableInteger15, nullableInstant: nullableInstant13, nullableBase64: nullableBase642 } = whatsappFields;
var column4 = (what, name) => `${what} (ZWAZACCOUNT.${name}).`;
var properties32 = {
  lid: {
    ...jid22,
    description: column4("The user\u2019s LID, the JID WhatsApp names them with in place of a phone number; the primary key", "ZIDENTIFIER")
  },
  phoneNumber: {
    ...nullableText22,
    description: column4("The user\u2019s phone number, digits only; <phoneNumber>@s.whatsapp.net is their phone JID. NULL when they do not share it", "ZPHONENUMBER")
  },
  countryCode: {
    ...nullableText22,
    description: column4("The country of the number, ISO 3166", "ZCOUNTRYCODE")
  },
  displayName: {
    ...nullableText22,
    description: column4("The name the user gave WhatsApp", "ZDISPLAYNAME")
  },
  username: {
    ...nullableText22,
    description: column4("The user\u2019s WhatsApp username", "ZUSERNAME")
  },
  userType: {
    ...nullableInteger15,
    description: column4("WhatsApp\u2019s undocumented user kind", "ZUSERTYPE")
  },
  state: {
    ...nullableInteger15,
    description: column4("WhatsApp\u2019s undocumented state code", "ZSTATE")
  },
  phoneNumberSharingState: {
    ...nullableInteger15,
    description: column4("WhatsApp\u2019s undocumented code for whether the user shares their number", "ZCURRENTPHONENUMBERSHARINGSTATE")
  },
  usernameState: {
    ...nullableInteger15,
    description: column4("WhatsApp\u2019s undocumented username state code", "ZUSERNAMESTATE")
  },
  createdAt: {
    ...nullableInstant13,
    description: column4("When WhatsApp recorded the user, UTC; 0000-12-30, Foundation\u2019s distant past, when it has no date", "ZCREATEDAT")
  },
  additionalData: {
    ...nullableBase642,
    description: column4("WhatsApp\u2019s additional data, base64", "ZADDITIONALDATA")
  }
};
var UsersStream = class extends WhatsAppStream {
  name = "users";
  store = "users";
  primaryKey = ["lid"];
  jsonSchema = {
    type: "object",
    description: "One record per WhatsApp user this account has seen, by LID, with the phone number when they share it (LID.sqlite). Join messages\u2019 and members\u2019 @lid JIDs here to reach a phone number. Primary key lid. Not narrowed by an import\u2019s chats or dates.",
    properties: properties32,
    required: Object.keys(properties32)
  };
  rows(scan) {
    return scan.users.users();
  }
  record({ additionalData, ...user }) {
    return { ...user, additionalData: base64(additionalData) };
  }
};

// packages/sources/whatsapp/desktop/dist/whatsapp-scan.js
var WhatsAppScan = class _WhatsAppScan {
  container;
  // When the run opened the stores, which expiring streams count from.
  startedAt = /* @__PURE__ */ new Date();
  #resources;
  #opened;
  #scoped;
  constructor(container, resources, opened, scoped) {
    this.container = container;
    this.#resources = resources;
    this.#opened = opened;
    this.#scoped = scoped;
  }
  static open(whatsapp, stores, scope) {
    var _stack = [];
    try {
      const resources = __using(_stack, new DisposableStack());
      const scoped = Object.keys(scope).length > 0;
      const needed = new Set(stores);
      if (scoped && stores.has("messageAssociations"))
        needed.add("chatStorage");
      const open = (store, reader) => {
        if (!needed.has(store))
          return void 0;
        try {
          return { reader: reader() };
        } catch (error) {
          return { error };
        }
      };
      const opened = {
        chatStorage: open("chatStorage", () => new ChatStorageRecords(resources.use(whatsapp.chatStorage()), scope)),
        contacts: open("contacts", () => resources.use(whatsapp.contacts())),
        users: open("users", () => resources.use(whatsapp.users())),
        calls: open("calls", () => resources.use(whatsapp.calls())),
        messageAssociations: open("messageAssociations", () => resources.use(whatsapp.messageAssociations())),
        businesses: open("businesses", () => resources.use(whatsapp.businesses())),
        statuses: open("statuses", () => resources.use(whatsapp.statuses())),
        stickers: open("stickers", () => resources.use(whatsapp.stickers())),
        localKeyValue: open("localKeyValue", () => resources.use(whatsapp.localKeyValue())),
        backedUpKeyValue: open("backedUpKeyValue", () => resources.use(whatsapp.backedUpKeyValue()))
      };
      return new _WhatsAppScan(whatsapp.container, resources.move(), opened, scoped);
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  get chatStorage() {
    return this.#reader("chatStorage");
  }
  get contacts() {
    return this.#reader("contacts");
  }
  get users() {
    return this.#reader("users");
  }
  get calls() {
    return this.#reader("calls");
  }
  get businesses() {
    return this.#reader("businesses");
  }
  get statuses() {
    return this.#reader("statuses");
  }
  get stickers() {
    return this.#reader("stickers");
  }
  get localKeyValue() {
    return this.#reader("localKeyValue");
  }
  get backedUpKeyValue() {
    return this.#reader("backedUpKeyValue");
  }
  messageAssociations() {
    const associations = this.#reader("messageAssociations").associations();
    if (!this.#scoped)
      return associations;
    const chats = this.chatStorage;
    return associations.filter(({ chatJid, stanzaId }) => chats.stanza(chatJid, stanzaId));
  }
  async [Symbol.asyncDispose]() {
    this.#resources.dispose();
  }
  #reader(store) {
    const opened = this.#opened[store];
    if (opened === void 0)
      throw new Error(`WhatsApp's ${store} store was not opened for this run`);
    if ("error" in opened)
      throw opened.error;
    return opened.reader;
  }
};

// packages/sources/whatsapp/desktop/dist/whatsapp-desktop-source.js
var readers = {
  chats: new ChatsStream(),
  messages: new MessagesStream(),
  messageReceipts: new MessageReceiptsStream(),
  messageReactions: new MessageReactionsStream(),
  messageReactionCounts: new MessageReactionCountsStream(),
  messageDataItems: new MessageDataItemsStream(),
  messageAssociations: new MessageAssociationsStream(),
  groupMembers: new GroupMembersStream(),
  groupMembersChanges: new GroupMembersChangesStream(),
  chatPushConfigs: new ChatPushConfigsStream(),
  pushNames: new PushNamesStream(),
  profilePictures: new ProfilePicturesStream(),
  blockedContacts: new BlockedContactsStream(),
  contacts: new ContactsStream(),
  users: new UsersStream(),
  calls: new CallsStream(),
  callParticipants: new CallParticipantsStream(),
  businessProfiles: new BusinessProfilesStream(),
  businessVerifiedNames: new BusinessVerifiedNamesStream(),
  businessCategories: new BusinessCategoriesStream(),
  businessHours: new BusinessHoursStream(),
  businessServiceAreas: new BusinessServiceAreasStream(),
  businessBotPrompts: new BusinessBotPromptsStream(),
  statuses: new StatusesStream(),
  stickerPacks: new StickerPacksStream(),
  stickers: new StickersStream(),
  favoriteStickers: new FavoriteStickersStream(),
  recentStickers: new RecentStickersStream(),
  privacySettings: new PrivacySettingsStream(),
  disappearingModes: new DisappearingModesStream(),
  linkedProfiles: new LinkedProfilesStream(),
  changedNumbers: new ChangedNumbersStream()
};
var catalog = new Catalog(Object.values(readers).map((reader) => reader.describe()));
var readersByName = new Map(Object.values(readers).map((reader) => [reader.name, reader]));
function readerOf(stream) {
  const reader = readersByName.get(stream.name);
  if (reader === void 0)
    throw new TypeError(`WhatsApp has no ${stream.name} stream`);
  return reader;
}
var pollIntervalMs = 1e3;
var WhatsAppDesktopSource = class extends Source {
  identity;
  catalog = catalog;
  chats = readers.chats.describe();
  messages = readers.messages.describe();
  messageReceipts = readers.messageReceipts.describe();
  messageReactions = readers.messageReactions.describe();
  messageReactionCounts = readers.messageReactionCounts.describe();
  messageDataItems = readers.messageDataItems.describe();
  messageAssociations = readers.messageAssociations.describe();
  groupMembers = readers.groupMembers.describe();
  groupMembersChanges = readers.groupMembersChanges.describe();
  chatPushConfigs = readers.chatPushConfigs.describe();
  pushNames = readers.pushNames.describe();
  profilePictures = readers.profilePictures.describe();
  blockedContacts = readers.blockedContacts.describe();
  contacts = readers.contacts.describe();
  users = readers.users.describe();
  calls = readers.calls.describe();
  callParticipants = readers.callParticipants.describe();
  businessProfiles = readers.businessProfiles.describe();
  businessVerifiedNames = readers.businessVerifiedNames.describe();
  businessCategories = readers.businessCategories.describe();
  businessHours = readers.businessHours.describe();
  businessServiceAreas = readers.businessServiceAreas.describe();
  businessBotPrompts = readers.businessBotPrompts.describe();
  statuses = readers.statuses.describe();
  stickerPacks = readers.stickerPacks.describe();
  stickers = readers.stickers.describe();
  favoriteStickers = readers.favoriteStickers.describe();
  recentStickers = readers.recentStickers.describe();
  privacySettings = readers.privacySettings.describe();
  disappearingModes = readers.disappearingModes.describe();
  linkedProfiles = readers.linkedProfiles.describe();
  changedNumbers = readers.changedNumbers.describe();
  container;
  scope;
  #whatsapp;
  constructor(container = whatsappContainer, scope = {}) {
    super();
    this.container = container;
    this.scope = scope;
    this.#whatsapp = new WhatsApp(container);
    this.identity = `whatsapp-desktop:${container}`;
    Object.freeze(this);
  }
  async open(streams) {
    return WhatsAppScan.open(this.#whatsapp, new Set(streams.map((stream) => readerOf(stream).store)), this.scope);
  }
  failureType(error) {
    return error instanceof WhatsAppUnavailableError ? "config" : "system";
  }
  coverage(_stream) {
    return {
      description: "What WhatsApp for Mac keeps on this Mac: the chats and messages it has synced from the phone and received while running, with the files it downloaded. WhatsApp writes its chats and messages only while the app runs, and drops a contact\u2019s status a day after it is posted. An import\u2019s chats and dates narrow chats, messages and what hangs off them; the other streams are not narrowed.",
      selection: this.scope
    };
  }
  // Each store the streams read reports its own commits.
  async *observe({ streams, signal }) {
    var _stack = [];
    try {
      if (signal.aborted)
        return;
      const versions = __using(_stack, new DisposableStack());
      const probes = new Map([...new Set(streams.map((stream) => readerOf(stream).store))].map((store) => [store, versions.use(this.#whatsapp.version(store))]));
      const seen = new Map([...probes].map(([store, probe]) => [store, probe.current]));
      yield streams;
      try {
        for await (const _2 of setInterval(pollIntervalMs, void 0, {
          signal
        })) {
          const changed = /* @__PURE__ */ new Set();
          for (const [store, probe] of probes) {
            const current = probe.current;
            if (current === seen.get(store))
              continue;
            seen.set(store, current);
            changed.add(store);
          }
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
    const { stream } = configuration;
    const reader = readerOf(stream);
    const records = reader.read(scan);
    const messages = configuration.syncMode === "incremental" ? diffSnapshot(stream, records, state, {
      policy: policyFor(reader.horizon(scan))
    }) : records.map((data) => ({ stream: stream.name, data }));
    for await (const message of messages) {
      if ("type" in message || configuration.fileReads.length === 0)
        yield message;
      else
        yield { ...message, file: reader.file(message.data, scan) };
    }
  }
};
function policyFor(horizon) {
  return horizon === void 0 ? new ClosedWorld() : new Retention(horizon);
}

// packages/connectors/apple/whatsapp/dist/whatsapp-connector.js
var WhatsAppConnector = class extends AppleConnector {
  datedBy = "date sent";
  fullDiskAccess = true;
  note = "WhatsApp saves messages to this Mac only while it runs, so messages sent while it is closed are imported once it has run again.";
  choices = [
    {
      stream: "chats",
      scope: "collectionIds",
      title: "chats",
      id: (row) => String(row.jid),
      label: (row) => String(row.partnerName ?? row.jid)
    }
  ];
  // What belongs to no chat: who people are, calls, statuses, businesses,
  // stickers and settings.
  unscoped = [
    "pushNames",
    "profilePictures",
    "blockedContacts",
    "contacts",
    "users",
    "calls",
    "callParticipants",
    "businessProfiles",
    "businessVerifiedNames",
    "businessCategories",
    "businessHours",
    "businessServiceAreas",
    "businessBotPrompts",
    "statuses",
    "stickerPacks",
    "stickers",
    "favoriteStickers",
    "recentStickers",
    "privacySettings",
    "disappearingModes",
    "linkedProfiles",
    "changedNumbers"
  ];
  storeCopies = [];
  access() {
    return "Open WhatsApp and let it run: it keeps what it has synced from your phone, and saves new messages to this Mac while it runs.";
  }
  source(scope) {
    return new WhatsAppDesktopSource(void 0, scope);
  }
};
export {
  WhatsAppConnector as default
};
