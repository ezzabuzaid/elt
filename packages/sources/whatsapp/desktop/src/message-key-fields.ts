import type { MessageKey } from '@workspace/sdk-whatsapp-desktop';

import { whatsappFields } from './whatsapp-stream.ts';

const { jid, boolean, text } = whatsappFields;

// The key of the message a record hangs off, as messages keys it.
export const messageKeyFields = {
  chatJid: {
    ...jid,
    description: 'The chat the message is in; refers to chats.jid.',
  },
  messageIsFromMe: {
    ...boolean,
    description:
      'Whether this account sent the message; with chatJid and messageStanzaId, refers to messages.',
  },
  messageStanzaId: {
    ...text,
    minLength: 1,
    description:
      'The stanza ID its sender gave the message; with chatJid and messageIsFromMe, refers to messages.',
  },
} as const;

export const messageKeyColumns = [
  'chatJid',
  'messageIsFromMe',
  'messageStanzaId',
] as const;

export function messageKeyRecord({ chatJid, isFromMe, stanzaId }: MessageKey) {
  return { chatJid, messageIsFromMe: isFromMe, messageStanzaId: stanzaId };
}
