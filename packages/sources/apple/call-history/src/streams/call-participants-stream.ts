import type { RecordDraft } from '@eltjs/elt';
import type { Participant } from '@eltjs/sdk-apple-call-history';

import {
  AppleCallHistoryStream,
  callHistoryFields,
} from '../apple-call-history-stream.ts';
import type { CallHistoryScan } from '../call-history-scan.ts';

const { id, text, integer, nullableText } = callHistoryFields;

const properties = {
  callId: {
    ...id,
    description:
      'The call; refers to calls.id within this source. Part of the primary key.',
  },
  handleId: {
    ...integer,
    description:
      'The store’s row number for the participant’s handle (ZHANDLE.Z_PK). Part of the primary key: CallHistory keeps one handle row for each party to a call, and two rows on one call can hold the same value.',
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
  readonly primaryKey = ['callId', 'handleId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per other party on a call (the call’s remote participant handles): one for a one-to-one call, several for a group FaceTime call, none when the number was withheld. Primary key callId, handleId: the primary key of the store’s call-to-handle join table. CallHistory keeps a copy of each handle per call, so a participant names a party to that call, not a contact, and two participants of one call can have the same type and value.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: CallHistoryScan): Iterable<Participant> {
    return scan.participants();
  }

  protected records(
    participant: Participant,
  ): RecordDraft<typeof properties>[] {
    return [
      {
        callId: participant.callId,
        handleId: participant.handleId,
        type: participant.handle.type,
        value: participant.handle.value,
        normalizedValue: participant.handle.normalizedValue,
      },
    ];
  }
}
