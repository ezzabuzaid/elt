// A phone number or address as callhistoryd stores it for one call. Each call
// gets its own copy, so a handle names a party to that call, not a person.
export type Handle = {
  // CallHistory's handle type code; its values are not documented.
  readonly type: number;
  readonly value: string;
  readonly normalizedValue: string | null;
};

// kCHCallTypeTelephony, kCHCallTypeFaceTimeVideo and kCHCallTypeFaceTimeAudio:
// the call types this reader has seen with their providers. CallHistory names
// others (VOIP, voicemail) whose numbers are not known.
type CallKind = 'phone' | 'faceTimeVideo' | 'faceTimeAudio';
const kinds = new Map<number, CallKind>([
  [1, 'phone'],
  [8, 'faceTimeVideo'],
  [16, 'faceTimeAudio'],
]);

// kCHCallCategoryAudio and kCHCallCategoryVideo; the TTY categories' numbers
// are not known.
type CallCategory = 'audio' | 'video';
const categories = new Map<number, CallCategory>([
  [1, 'audio'],
  [2, 'video'],
]);

export function callKind(code: number | null): CallKind | null {
  return code === null ? null : (kinds.get(code) ?? null);
}

export function callCategory(code: number | null): CallCategory | null {
  return code === null ? null : (categories.get(code) ?? null);
}

// One call record. Codes CallHistory does not document stay numbers.
export type Call = {
  readonly id: string;
  // UTC, to the microsecond: 2026-09-01T10:00:00.250123Z.
  readonly startedAt: string | null;
  readonly duration: number | null;
  readonly serviceProvider: string | null;
  readonly kind: CallKind | null;
  readonly kindCode: number | null;
  readonly category: CallCategory | null;
  readonly categoryCode: number | null;
  readonly outgoing: boolean | null;
  readonly answered: boolean | null;
  readonly read: boolean | null;
  readonly hasMessage: boolean | null;
  readonly address: string | null;
  readonly name: string | null;
  readonly location: string | null;
  readonly isoCountryCode: string | null;
  readonly handleType: number | null;
  readonly initiator: Handle | null;
  readonly numberAvailability: number | null;
  readonly disconnectedCause: number | null;
  readonly filteredOutReason: number | null;
  readonly blockedByExtension: string | null;
  readonly blockedByExtensionName: string | null;
  readonly identityExtension: string | null;
  readonly callDirectoryIdentityType: number | null;
  readonly junkConfidence: number | null;
  readonly junkIdentificationCategory: string | null;
  readonly verificationStatus: number | null;
  readonly communicationTrustScore: number | null;
  readonly autoAnsweredReason: number | null;
  readonly screenSharingType: number | null;
  readonly originatingUIType: number | null;
  readonly originatingDeviceName: string | null;
  readonly faceTimeData: number | null;
  readonly wasEmergencyCall: boolean | null;
  readonly usedEmergencyVideoStreaming: boolean | null;
  readonly didEnableTranslation: boolean | null;
  readonly neededSCAnnouncement: boolean | null;
  readonly conversationId: string | null;
  readonly localParticipantUuid: string | null;
  readonly outgoingLocalParticipantUuid: string | null;
  readonly participantGroupUuid: string | null;
  readonly reminderUuid: string | null;
  readonly imageUrl: string | null;
  readonly saintDavids1: number | null;
  readonly saintDavids2: string | null;
};
