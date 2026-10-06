import type { RecordDraft } from '@workspace/elt';
import type { Call } from '@workspace/sdk-apple-call-history';

import {
  AppleCallHistoryStream,
  callHistoryFields,
} from '../apple-call-history-stream.ts';
import type { CallHistoryScan } from '../call-history-scan.ts';

const {
  id,
  nullableText,
  nullableBoolean,
  nullableInteger,
  nullableSeconds,
  nullableInstant,
} = callHistoryFields;
const stored = (what: string, column: string) =>
  `${what} (ZCALLRECORD.${column}); NULL when callhistoryd stores none.`;
const code = (what: string, column: string) =>
  `${what}: CallHistory's own code (ZCALLRECORD.${column}), whose values Apple does not document; NULL when none is stored.`;
const uuid = (what: string, column: string) =>
  stored(`${what}, a UUID in uppercase`, column);

const properties = {
  id: {
    ...id,
    description:
      'The call record’s unique ID (ZCALLRECORD.ZUNIQUE_ID); the primary key. callParticipants.callId, emergencyMediaItems.callId and saintDavidsCounts.callId refer to it within this source. The same call has the same ID on every device that syncs call history through iCloud.',
  },
  startedAt: {
    ...nullableInstant,
    description:
      'When the call started, in UTC to the microsecond (ZCALLRECORD.ZDATE, Core Data seconds since 2001-01-01 in a double); NULL when not recorded. An import’s date range selects calls by it.',
  },
  duration: {
    ...nullableSeconds,
    description: stored('How long the call lasted, in seconds', 'ZDURATION'),
  },
  serviceProvider: {
    ...nullableText,
    description: stored(
      'The service that carried the call, such as com.apple.Telephony for a phone call or com.apple.FaceTime',
      'ZSERVICE_PROVIDER',
    ),
  },
  kind: {
    ...nullableText,
    enum: ['phone', 'faceTimeVideo', 'faceTimeAudio'],
    description:
      'The kind of call: phone, faceTimeVideo or faceTimeAudio, from kindCode. NULL when kindCode is NULL or a code this reader does not know.',
  },
  kindCode: {
    ...nullableInteger,
    description:
      'CallHistory’s call type (ZCALLRECORD.ZCALLTYPE): 1 phone, 8 FaceTime video, 16 FaceTime audio. Kept as stored, so a type Apple adds later still loads.',
  },
  category: {
    ...nullableText,
    enum: ['audio', 'video'],
    description:
      'Whether the call was audio or video, from categoryCode. NULL when categoryCode is NULL or a code this reader does not know, such as a TTY call.',
  },
  categoryCode: {
    ...nullableInteger,
    description:
      'CallHistory’s call category (ZCALLRECORD.ZCALL_CATEGORY): 1 audio, 2 video. Kept as stored.',
  },
  outgoing: {
    ...nullableBoolean,
    description: stored(
      'Whether this side placed the call; false for an incoming call',
      'ZORIGINATED',
    ),
  },
  answered: {
    ...nullableBoolean,
    description: stored('Whether the call was answered', 'ZANSWERED'),
  },
  read: {
    ...nullableBoolean,
    description: stored(
      'Whether a missed call has been seen in Recents',
      'ZREAD',
    ),
  },
  hasMessage: {
    ...nullableBoolean,
    description: stored('Whether the caller left a message', 'ZHASMESSAGE'),
  },
  address: {
    ...nullableText,
    description: stored(
      'The other party’s phone number or address as the call recorded it',
      'ZADDRESS',
    ),
  },
  name: {
    ...nullableText,
    description: stored(
      'The name the call showed for the other party',
      'ZNAME',
    ),
  },
  location: {
    ...nullableText,
    description: stored(
      'The place the number belongs to, such as a city or country',
      'ZLOCATION',
    ),
  },
  isoCountryCode: {
    ...nullableText,
    description: stored(
      'The ISO country code the number was read in',
      'ZISO_COUNTRY_CODE',
    ),
  },
  handleType: {
    ...nullableInteger,
    description: code('The kind of address', 'ZHANDLE_TYPE'),
  },
  initiatorType: {
    ...nullableInteger,
    description:
      'The handle type of the party who started the call (ZHANDLE.ZTYPE through ZCALLRECORD.ZINITIATOR), a code Apple does not document; NULL when the call names no initiator.',
  },
  initiatorValue: {
    ...nullableText,
    description:
      'The phone number or address of the party who started the call (ZHANDLE.ZVALUE through ZCALLRECORD.ZINITIATOR); NULL when the call names no initiator.',
  },
  initiatorNormalizedValue: {
    ...nullableText,
    description:
      'initiatorValue as CallHistory normalizes it for matching (ZHANDLE.ZNORMALIZEDVALUE); NULL when not stored.',
  },
  numberAvailability: {
    ...nullableInteger,
    description: code(
      'Whether the caller’s number was available',
      'ZNUMBER_AVAILABILITY',
    ),
  },
  disconnectedCause: {
    ...nullableInteger,
    description: code('Why the call ended', 'ZDISCONNECTED_CAUSE'),
  },
  filteredOutReason: {
    ...nullableInteger,
    description: code(
      'Why the call was filtered out of Recents',
      'ZFILTERED_OUT_REASON',
    ),
  },
  blockedByExtension: {
    ...nullableText,
    description: stored(
      'The bundle identifier of the call blocking extension that blocked the call',
      'ZBLOCKEDBYEXTENSION',
    ),
  },
  blockedByExtensionName: {
    ...nullableText,
    description: stored(
      'The name of that blocking extension',
      'ZBLOCKEDBYEXTENSIONNAME',
    ),
  },
  identityExtension: {
    ...nullableText,
    description: stored(
      'The bundle identifier of the caller ID extension that named the caller',
      'ZIDENTITYEXTENSION',
    ),
  },
  callDirectoryIdentityType: {
    ...nullableInteger,
    description: code(
      'How a caller ID extension identified the caller',
      'ZCALLDIRECTORYIDENTITYTYPE',
    ),
  },
  junkConfidence: {
    ...nullableInteger,
    description: code('How likely the call is junk', 'ZJUNKCONFIDENCE'),
  },
  junkIdentificationCategory: {
    ...nullableText,
    description: stored(
      'The category under which the call was identified as junk',
      'ZJUNKIDENTIFICATIONCATEGORY',
    ),
  },
  verificationStatus: {
    ...nullableInteger,
    description: code(
      'Whether the caller’s number was verified',
      'ZVERIFICATIONSTATUS',
    ),
  },
  communicationTrustScore: {
    ...nullableInteger,
    description: code(
      'How much the caller is trusted',
      'ZCOMMUNICATIONTRUSTSCORE',
    ),
  },
  autoAnsweredReason: {
    ...nullableInteger,
    description: code(
      'Why the call was answered automatically',
      'ZAUTOANSWEREDREASON',
    ),
  },
  screenSharingType: {
    ...nullableInteger,
    description: code(
      'Whether and how the screen was shared',
      'ZSCREENSHARINGTYPE',
    ),
  },
  originatingUIType: {
    ...nullableInteger,
    description: code(
      'Where the call was started, such as the Messages avatar bar or a side button hold',
      'ZORIGINATINGUITYPE',
    ),
  },
  originatingDeviceName: {
    ...nullableText,
    description: stored(
      'The name of the device the call was made on',
      'ZORIGINATINGDEVICENAME',
    ),
  },
  faceTimeData: {
    ...nullableInteger,
    description: code(
      'FaceTime data for the call, kept as stored',
      'ZFACE_TIME_DATA',
    ),
  },
  wasEmergencyCall: {
    ...nullableBoolean,
    description: stored(
      'Whether the call was an emergency call',
      'ZWASEMERGENCYCALL',
    ),
  },
  usedEmergencyVideoStreaming: {
    ...nullableBoolean,
    description: stored(
      'Whether video was streamed to emergency services',
      'ZUSEDEMERGENCYVIDEOSTREAMING',
    ),
  },
  didEnableTranslation: {
    ...nullableBoolean,
    description: stored(
      'Whether live translation was turned on',
      'ZDIDENABLETRANSLATION',
    ),
  },
  neededSCAnnouncement: {
    ...nullableBoolean,
    description: stored(
      'CallHistory’s neededSCAnnouncement flag, kept as stored',
      'ZNEEDEDSCANNOUNCEMENT',
    ),
  },
  conversationId: {
    ...nullableText,
    description: uuid(
      'The FaceTime conversation the call belonged to',
      'ZCONVERSATIONID',
    ),
  },
  localParticipantUuid: {
    ...nullableText,
    description: uuid(
      'This device’s participant in the conversation',
      'ZLOCALPARTICIPANTUUID',
    ),
  },
  outgoingLocalParticipantUuid: {
    ...nullableText,
    description: uuid(
      'This device’s participant when it placed the call',
      'ZOUTGOINGLOCALPARTICIPANTUUID',
    ),
  },
  participantGroupUuid: {
    ...nullableText,
    description: uuid(
      'The group of participants in a group call',
      'ZPARTICIPANTGROUPUUID',
    ),
  },
  reminderUuid: {
    ...nullableText,
    description: uuid('The reminder set to return the call', 'ZREMINDERUUID'),
  },
  imageUrl: {
    ...nullableText,
    description: stored('The image URL shown for the call', 'ZIMAGEURL'),
  },
  saintDavids1: {
    ...nullableInteger,
    description: code(
      'CallHistory’s saint_davids_1 value, an Apple feature it does not name',
      'ZSAINT_DAVIDS_1',
    ),
  },
  saintDavids2: {
    ...nullableText,
    description: stored(
      'CallHistory’s saint_davids_2 value, an Apple feature it does not name',
      'ZSAINT_DAVIDS_2',
    ),
  },
} as const;

export class CallsStream extends AppleCallHistoryStream<
  typeof properties,
  Call
> {
  readonly name = 'calls';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      "One record per call in this Mac's call history (~/Library/Application Support/CallHistoryDB/CallHistory.storedata): phone calls relayed from an iPhone or synced through iCloud, and FaceTime calls. Primary key id. Read from the CallHistory framework's Core Data store without Phone, FaceTime or the framework.",
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: CallHistoryScan): readonly Call[] {
    return scan.calls;
  }

  protected records(call: Call): RecordDraft<typeof properties>[] {
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
        saintDavids2: call.saintDavids2,
      },
    ];
  }
}
