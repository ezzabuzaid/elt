import type { RecordDraft } from '@workspace/elt';
import type { MessageAssociation } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { jid, text, integer } = whatsappFields;

const properties = {
  chatJid: {
    ...jid,
    description: 'The chat both messages are in; refers to chats.jid.',
  },
  stanzaId: {
    ...text,
    minLength: 1,
    description:
      'The message shown as part of another; with chatJid, refers to messages.stanzaId.',
  },
  type: {
    ...integer,
    description:
      'WhatsApp’s undocumented kind of link: 1 joins a photo or video to its album; 5, 10 and 12 link other images and videos to their parent.',
  },
  parentStanzaId: {
    ...text,
    minLength: 1,
    description: 'The message it is part of, such as the album.',
  },
  sort: {
    ...integer,
    description: 'WhatsApp’s order of the message in its chat.',
  },
} as const;

export class MessageAssociationsStream extends WhatsAppStream<
  typeof properties,
  MessageAssociation
> {
  readonly name = 'messageAssociations';
  readonly store = 'messageAssociations';
  readonly primaryKey = ['chatJid', 'stanzaId', 'type'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per message WhatsApp shows as part of another of the same chat, such as a photo of an album (ExtChatDB’s message_parent_association). Primary key chatJid, stanzaId, type, as the table keys it.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): Iterable<MessageAssociation> {
    return scan.messageAssociations();
  }

  protected record(
    association: MessageAssociation,
  ): RecordDraft<typeof properties> {
    return { ...association };
  }
}
