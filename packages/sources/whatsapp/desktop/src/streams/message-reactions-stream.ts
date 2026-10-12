import type { RecordDraft } from '@workspace/elt';
import type { Reaction } from '@workspace/sdk-whatsapp-desktop';

import type { OnMessage } from '../chat-storage-records.ts';
import {
  messageKeyColumns,
  messageKeyFields,
  messageKeyRecord,
} from '../message-key-fields.ts';
import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { text, boolean, nullableJid, nullableText } = whatsappFields;

const properties = {
  ...messageKeyFields,
  reactionStanzaId: {
    ...text,
    minLength: 1,
    description: 'The ID its sender gave the reaction.',
  },
  senderJid: {
    ...nullableJid,
    description: 'Who reacted; NULL when this account did.',
  },
  isFromMe: {
    ...boolean,
    description: 'Whether this account reacted.',
  },
  emoji: {
    ...nullableText,
    description:
      'The reaction; NULL when its sender withdrew it, which WhatsApp keeps.',
  },
  reactedAt: {
    ...text,
    format: 'date-time',
    description: 'When the reaction was sent, UTC to the millisecond.',
  },
} as const;

export class MessageReactionsStream extends WhatsAppStream<
  typeof properties,
  OnMessage<Reaction>
> {
  readonly name = 'messageReactions';
  readonly store = 'chatStorage';
  readonly primaryKey = [...messageKeyColumns, 'reactionStanzaId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per reaction to a message, decoded from the message’s receipt info (ZWAMESSAGEINFO.ZRECEIPTINFO). Primary key chatJid, messageIsFromMe, messageStanzaId, reactionStanzaId. A channel post keeps counts instead; see messageReactionCounts.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): readonly OnMessage<Reaction>[] {
    return scan.chatStorage.reactions;
  }

  protected record({
    message,
    item: { stanzaId, ...reaction },
  }: OnMessage<Reaction>): RecordDraft<typeof properties> {
    return {
      ...messageKeyRecord(message),
      reactionStanzaId: stanzaId,
      ...reaction,
    };
  }
}
