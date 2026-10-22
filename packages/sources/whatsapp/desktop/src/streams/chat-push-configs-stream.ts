import type { RecordDraft } from '@workspace/elt';
import type { ChatPushConfig } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { jid, nullableInteger, nullableText, nullableInstant } = whatsappFields;

const properties = {
  jid: {
    ...jid,
    description:
      'The chat; refers to chats.jid when WhatsApp still has it (ZJID).',
  },
  alerts: {
    ...nullableInteger,
    description:
      'WhatsApp’s undocumented code for the chat’s alerts (ZALERTS).',
  },
  mutedUntil: {
    ...nullableInstant,
    description:
      'When the chat’s mute ends, UTC (ZMUTEDUNTIL); 4001-01-01 for a chat muted always.',
  },
  sound: {
    ...nullableText,
    description: 'The chat’s message sound (ZSOUND).',
  },
  ringtone: {
    ...nullableText,
    description: 'The chat’s ringtone (ZRINGTONE).',
  },
} as const;

export class ChatPushConfigsStream extends WhatsAppStream<
  typeof properties,
  ChatPushConfig
> {
  readonly name = 'chatPushConfigs';
  readonly store = 'chatStorage';
  readonly primaryKey = ['jid'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per chat with its own notification settings, such as a mute (ZWACHATPUSHCONFIG). Primary key jid.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): Iterable<ChatPushConfig> {
    return scan.chatStorage.chatPushConfigs;
  }

  protected record(config: ChatPushConfig): RecordDraft<typeof properties> {
    return { ...config };
  }
}
