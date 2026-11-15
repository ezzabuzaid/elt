import type { RecordDraft } from '@eltjs/elt';
import type { Call } from '@eltjs/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, rowId, whatsappFields } from '../whatsapp-stream.ts';

const {
  text,
  nullableJid,
  nullableText,
  nullableInteger,
  nullableNumber,
  nullableBoolean,
  nullableInstant,
} = whatsappFields;
const call = (what: string, name: string) =>
  `${what} (ZWACDCALLEVENT.${name}).`;
const log = (what: string, name: string) =>
  `${what}, from the call-log entry holding the call (ZWAAGGREGATECALLEVENT.${name}).`;

const properties = {
  id: rowId('ZWACDCALLEVENT'),
  callLogId: {
    ...nullableInteger,
    description:
      'The call-log entry that holds the call (ZWAAGGREGATECALLEVENT.Z_PK); callParticipants.callLogId names the same entry. NULL when no entry holds it.',
  },
  callId: {
    ...text,
    minLength: 1,
    description: call('The call’s ID', 'ZCALLIDSTRING'),
  },
  date: {
    ...nullableInstant,
    description: call('When the call started, UTC', 'ZDATE'),
  },
  duration: {
    ...nullableNumber,
    minimum: 0,
    description: call('How long the call lasted, in seconds', 'ZDURATION'),
  },
  outcome: {
    ...nullableInteger,
    description: call(
      'WhatsApp’s undocumented code for how the call ended',
      'ZOUTCOME',
    ),
  },
  bytesSent: {
    ...nullableInteger,
    description: call('Bytes sent', 'ZBYTESSENT'),
  },
  bytesReceived: {
    ...nullableInteger,
    description: call('Bytes received', 'ZBYTESRECEIVED'),
  },
  groupJid: {
    ...nullableJid,
    description: call('The group of a group call', 'ZGROUPJIDSTRING'),
  },
  groupCallCreatorJid: {
    ...nullableJid,
    description: call(
      'Who started a group call',
      'ZGROUPCALLCREATORUSERJIDSTRING',
    ),
  },
  isBotGroupCall: {
    ...nullableBoolean,
    description: call(
      'Whether a bot took part in the group call',
      'ZISBOTGROUPCALL',
    ),
  },
  isLightweight: {
    ...nullableBoolean,
    description: call('WhatsApp’s lightweight call flag', 'ZISLIGHTWEIGHT'),
  },
  reminderId: {
    ...nullableText,
    description: call('The reminder set for the call', 'ZREMINDERID'),
  },
  scheduledId: {
    ...nullableText,
    description: call('The scheduled call it was', 'ZSCHEDULEDID'),
  },
  incoming: {
    ...nullableBoolean,
    description: log('Whether the call came in', 'ZINCOMING'),
  },
  missed: {
    ...nullableBoolean,
    description: log('Whether the call was missed', 'ZMISSED'),
  },
  missedReason: {
    ...nullableInteger,
    description: log(
      'WhatsApp’s undocumented reason code for a missed call',
      'ZMISSEDREASON',
    ),
  },
  video: {
    ...nullableBoolean,
    description: log('Whether it was a video call', 'ZVIDEO'),
  },
  firstDate: {
    ...nullableInstant,
    description: log('When the entry’s first call started, UTC', 'ZFIRSTDATE'),
  },
  linkToken: {
    ...nullableText,
    description: log('The call link’s token', 'ZLINKTOKEN'),
  },
} as const;

export class CallsStream extends WhatsAppStream<typeof properties, Call> {
  readonly name = 'calls';
  readonly store = 'calls';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per WhatsApp call (CallHistory.sqlite), with the call-log entry that holds it. Primary key id. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): Iterable<Call> {
    return scan.calls.calls();
  }

  protected record(call: Call): RecordDraft<typeof properties> {
    return { ...call };
  }
}
