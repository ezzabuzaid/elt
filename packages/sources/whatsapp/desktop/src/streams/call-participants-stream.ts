import type { RecordDraft } from '@workspace/elt';
import type { CallParticipant } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { text, jid, nullableInteger } = whatsappFields;

const properties = {
  callId: {
    ...text,
    minLength: 1,
    description: 'The call; refers to calls.callId.',
  },
  jid: {
    ...jid,
    description: 'The other party (ZWACDCALLEVENTPARTICIPANT.ZJIDSTRING).',
  },
  outcome: {
    ...nullableInteger,
    description:
      'WhatsApp’s undocumented code for how the call went for them (ZOUTCOME).',
  },
} as const;

export class CallParticipantsStream extends WhatsAppStream<
  typeof properties,
  CallParticipant
> {
  readonly name = 'callParticipants';
  readonly store = 'calls';
  readonly primaryKey = ['callId', 'jid'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per other party on a call. WhatsApp keeps participants on the call-log entry, so each call an entry holds lists them all. Primary key callId, jid. Not narrowed by an import’s chats or dates.',
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
