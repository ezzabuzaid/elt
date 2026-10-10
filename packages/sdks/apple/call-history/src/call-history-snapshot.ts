import {
  AppDatabase,
  type AppDatabaseColumns,
  referenceDateInstant,
} from '@workspace/sdk-apple-app-database';

import { type Call, type Handle, callCategory, callKind } from './call.ts';
import {
  CallHistorySchemaError,
  CallHistoryUnavailableError,
} from './errors.ts';

// A party to one call, other than this device's user.
export type Participant = {
  readonly callId: string;
  readonly handle: Handle;
};

// The Phone app's call-time totals, in seconds.
export type CallTimers = {
  readonly id: number;
  readonly all: number | null;
  readonly incoming: number | null;
  readonly outgoing: number | null;
  readonly last: number | null;
  readonly lifetime: number | null;
};

// Media shared during an emergency call. Apple's model makes its call
// optional, so callId can be null.
export type EmergencyMediaItem = {
  readonly id: number;
  readonly callId: string | null;
  readonly mediaType: number | null;
  readonly assetId: string | null;
};

// A count CallHistory keeps per call and type code (its Saint Davids
// entity). Apple names neither the feature nor its codes.
export type SaintDavidsCount = {
  readonly id: number;
  readonly callId: string | null;
  readonly type: number | null;
  readonly count: number | null;
};

const requiredColumns = {
  ZCALLRECORD: [
    'Z_PK',
    'ZUNIQUE_ID',
    'ZDATE',
    'ZDURATION',
    'ZSERVICE_PROVIDER',
    'ZCALLTYPE',
    'ZCALL_CATEGORY',
    'ZORIGINATED',
    'ZANSWERED',
    'ZREAD',
    'ZHASMESSAGE',
    'ZADDRESS',
    'ZNAME',
    'ZLOCATION',
    'ZISO_COUNTRY_CODE',
    'ZHANDLE_TYPE',
    'ZINITIATOR',
    'ZNUMBER_AVAILABILITY',
    'ZDISCONNECTED_CAUSE',
    'ZFILTERED_OUT_REASON',
    'ZBLOCKEDBYEXTENSION',
    'ZBLOCKEDBYEXTENSIONNAME',
    'ZIDENTITYEXTENSION',
    'ZCALLDIRECTORYIDENTITYTYPE',
    'ZJUNKCONFIDENCE',
    'ZJUNKIDENTIFICATIONCATEGORY',
    'ZVERIFICATIONSTATUS',
    'ZCOMMUNICATIONTRUSTSCORE',
    'ZAUTOANSWEREDREASON',
    'ZSCREENSHARINGTYPE',
    'ZORIGINATINGUITYPE',
    'ZORIGINATINGDEVICENAME',
    'ZFACE_TIME_DATA',
    'ZWASEMERGENCYCALL',
    'ZUSEDEMERGENCYVIDEOSTREAMING',
    'ZDIDENABLETRANSLATION',
    'ZNEEDEDSCANNOUNCEMENT',
    'ZCONVERSATIONID',
    'ZLOCALPARTICIPANTUUID',
    'ZOUTGOINGLOCALPARTICIPANTUUID',
    'ZPARTICIPANTGROUPUUID',
    'ZREMINDERUUID',
    'ZIMAGEURL',
    'ZSAINT_DAVIDS_1',
    'ZSAINT_DAVIDS_2',
  ],
  ZHANDLE: ['Z_PK', 'ZTYPE', 'ZVALUE', 'ZNORMALIZEDVALUE'],
  ZCALLDBPROPERTIES: [
    'Z_PK',
    'ZTIMER_ALL',
    'ZTIMER_INCOMING',
    'ZTIMER_OUTGOING',
    'ZTIMER_LAST',
    'ZTIMER_LIFETIME',
  ],
  ZEMERGENCYMEDIAITEM: [
    'Z_PK',
    'ZUPLOADEDFORCALL',
    'ZEMERGENCYMEDIATYPE',
    'ZASSETID',
  ],
  ZSAINTDAVIDSCOUNTS: ['Z_PK', 'ZCALL', 'ZTYPE', 'ZCOUNT'],
} satisfies AppDatabaseColumns;

// The store as of one moment: everything read through it agrees, and each kind
// of record is read on request. A layout missing any column this reader reads
// is refused when the snapshot opens. Hold it only while reading: an open read
// stops callhistoryd checkpointing its WAL.
export class CallHistorySnapshot implements Disposable {
  readonly #database: AppDatabase;

  constructor(path: string) {
    this.#database = new AppDatabase(path, CallHistoryUnavailableError);
    this.#database.requireColumns(requiredColumns, CallHistorySchemaError);
  }

  calls(): Call[] {
    return this.#database
      .all(
        `SELECT record.ZUNIQUE_ID AS id,
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
         ORDER BY record.Z_PK`,
      )
      .map((row) => {
        const kindCode = number(row.kindCode);
        const categoryCode = number(row.categoryCode);
        return {
          id: required(row.id, 'A call has no unique ID'),
          startedAt:
            row.startedAt === null
              ? null
              : referenceDateInstant(Number(row.startedAt)),
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
          initiator:
            row.initiatorValue === null
              ? null
              : handle(
                  row.initiatorType,
                  row.initiatorValue,
                  row.initiatorNormalizedValue,
                ),
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
          saintDavids2: string(row.saintDavids2),
        };
      });
  }

  participants(): Participant[] {
    const { table, call, handle: other } = this.#participantLinks();
    return this.#database
      .all(
        `SELECT record.ZUNIQUE_ID AS callId, handle.ZTYPE AS type,
                handle.ZVALUE AS value, handle.ZNORMALIZEDVALUE AS normalizedValue
         FROM "${table}" AS link
         JOIN ZCALLRECORD AS record ON record.Z_PK = link."${call}"
         JOIN ZHANDLE AS handle ON handle.Z_PK = link."${other}"
         ORDER BY record.Z_PK, handle.Z_PK`,
      )
      .map((row) => ({
        callId: required(row.callId, 'A call has no unique ID'),
        handle: handle(row.type, row.value, row.normalizedValue),
      }));
  }

  timers(): CallTimers[] {
    return this.#database
      .all(
        `SELECT Z_PK AS id, ZTIMER_ALL AS "all", ZTIMER_INCOMING AS incoming,
                ZTIMER_OUTGOING AS outgoing, ZTIMER_LAST AS last,
                ZTIMER_LIFETIME AS lifetime
         FROM ZCALLDBPROPERTIES ORDER BY Z_PK`,
      )
      .map((row) => ({
        id: Number(row.id),
        all: number(row.all),
        incoming: number(row.incoming),
        outgoing: number(row.outgoing),
        last: number(row.last),
        lifetime: number(row.lifetime),
      }));
  }

  emergencyMediaItems(): EmergencyMediaItem[] {
    return this.#database
      .all(
        `SELECT item.Z_PK AS id, record.ZUNIQUE_ID AS callId,
                item.ZEMERGENCYMEDIATYPE AS mediaType, item.ZASSETID AS assetId
         FROM ZEMERGENCYMEDIAITEM AS item
         LEFT JOIN ZCALLRECORD AS record ON record.Z_PK = item.ZUPLOADEDFORCALL
         ORDER BY item.Z_PK`,
      )
      .map((row) => ({
        id: Number(row.id),
        callId: string(row.callId),
        mediaType: number(row.mediaType),
        assetId: string(row.assetId),
      }));
  }

  saintDavidsCounts(): SaintDavidsCount[] {
    return this.#database
      .all(
        `SELECT counted.Z_PK AS id, record.ZUNIQUE_ID AS callId,
                counted.ZTYPE AS type, counted.ZCOUNT AS count
         FROM ZSAINTDAVIDSCOUNTS AS counted
         LEFT JOIN ZCALLRECORD AS record ON record.Z_PK = counted.ZCALL
         ORDER BY counted.Z_PK`,
      )
      .map((row) => ({
        id: Number(row.id),
        callId: string(row.callId),
        type: number(row.type),
        count: number(row.count),
      }));
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }

  // Core Data names the join table and its columns after entity numbers that
  // change between macOS versions (Z_2REMOTEPARTICIPANTHANDLES today), so the
  // table is found by its name's end, its call column by its own, and the
  // handle column is the table's remaining one.
  #participantLinks(): { table: string; call: string; handle: string } {
    const table = this.#database.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'Z_*REMOTEPARTICIPANTHANDLES'",
    )[0]?.name;
    if (typeof table !== 'string')
      throw new CallHistorySchemaError(this.#database.path, [
        'Z_*REMOTEPARTICIPANTHANDLES',
      ]);
    const columns = this.#database
      .all('SELECT name FROM pragma_table_info(?)', table)
      .map(({ name }) => String(name));
    const call = columns.find((name) =>
      name.endsWith('REMOTEPARTICIPANTCALLS'),
    );
    const handle = columns.find((name) => name !== call);
    if (call === undefined || handle === undefined || columns.length !== 2)
      throw new CallHistorySchemaError(this.#database.path, [
        `${table}.Z_*REMOTEPARTICIPANTCALLS`,
      ]);
    return { table, call, handle };
  }
}

function handle(
  type: unknown,
  value: unknown,
  normalizedValue: unknown,
): Handle {
  return {
    type: Number(type),
    value: required(value, 'A call handle has no value'),
    normalizedValue: string(normalizedValue),
  };
}

// Core Data's UUID attributes are 16 bytes; written as NSUUID writes them.
function uuid(value: unknown): string | null {
  if (value === null) return null;
  if (!(value instanceof Uint8Array) || value.length !== 16)
    throw new TypeError('A call UUID is not 16 bytes');
  const hex = Buffer.from(value).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase();
}

function required(value: unknown, missing: string): string {
  if (typeof value !== 'string') throw new TypeError(missing);
  return value;
}

function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function number(value: unknown): number | null {
  return value === null ? null : Number(value);
}

function flag(value: unknown): boolean | null {
  return value === null ? null : Number(value) === 1;
}
