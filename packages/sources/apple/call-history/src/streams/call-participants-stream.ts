import type { RecordDraft } from '@workspace/elt';
import type { Participant } from '@workspace/sdk-apple-call-history';

import {
  AppleCallHistoryStream,
  callHistoryFields,
} from '../apple-call-history-stream.ts';
import type { CallHistoryScan } from '../call-history-scan.ts';

const { id, text, integer, nullableText } = callHistoryFields;

const properties = {
  callId: {
    ...id,
    description: 'The call; refers to calls.id within this source.',
  },
  type: {
    ...integer,
    description:
      'CallHistory’s handle type code (ZHANDLE.ZTYPE), whose values Apple does not document.',
  },
  value: {
    ...text,
    description:
      'The participant’s phone number or address as the call recorded it (ZHANDLE.ZVALUE).',
  },
  normalizedValue: {
    ...nullableText,
    description:
      'value as CallHistory normalizes it for matching (ZHANDLE.ZNORMALIZEDVALUE); NULL when not stored.',
  },
} as const;

export class CallParticipantsStream extends AppleCallHistoryStream<
  typeof properties,
  Participant
> {
  readonly name = 'callParticipants';
  readonly primaryKey = ['callId', 'type', 'value'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per other party on a call (the call’s remote participant handles): one for a one-to-one call, several for a group FaceTime call, none when the number was withheld. Primary key callId, type, value. CallHistory keeps a copy of each handle per call, so a participant names a party to that call, not a contact.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: CallHistoryScan): readonly Participant[] {
    return scan.participants;
  }

  protected records(
    participant: Participant,
  ): RecordDraft<typeof properties>[] {
    return [
      {
        callId: participant.callId,
        type: participant.handle.type,
        value: participant.handle.value,
        normalizedValue: participant.handle.normalizedValue,
      },
    ];
  }
}
