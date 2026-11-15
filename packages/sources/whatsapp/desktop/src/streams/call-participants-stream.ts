import type { RecordDraft } from '@eltjs/elt';
import type { CallParticipant } from '@eltjs/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, rowId, whatsappFields } from '../whatsapp-stream.ts';

const { jid, nullableInteger } = whatsappFields;

const properties = {
  id: rowId('ZWACDCALLEVENTPARTICIPANT'),
  callLogId: {
    ...nullableInteger,
    description:
      'The call-log entry the participant is on; refers to calls.callLogId, the entry of each call it holds. NULL when no entry holds the participant.',
  },
  jid: {
    ...jid,
    description: 'The other party (ZWACDCALLEVENTPARTICIPANT.ZJIDSTRING).',
  },
  outcome: {
    ...nullableInteger,
    description:
      'WhatsApp’s undocumented code for how the entry’s calls went for them (ZOUTCOME).',
  },
} as const;

export class CallParticipantsStream extends WhatsAppStream<
  typeof properties,
  CallParticipant
> {
  readonly name = 'callParticipants';
  readonly store = 'calls';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per other party on a call-log entry. WhatsApp keeps participants on the entry, not on each call: join calls on callLogId for the calls they were on. Primary key id. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): Iterable<CallParticipant> {
    return scan.calls.participants();
  }

  protected record(
    participant: CallParticipant,
  ): RecordDraft<typeof properties> {
    return { ...participant };
  }
}
