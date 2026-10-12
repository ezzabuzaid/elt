import type { RecordDraft } from '@workspace/elt';
import type { MessageDataItem } from '@workspace/sdk-whatsapp-desktop';

import {
  messageKeyColumns,
  messageKeyFields,
  messageKeyRecord,
} from '../message-key-fields.ts';
import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const {
  integer,
  nullableInteger,
  nullableText,
  nullableJid,
  nullableBoolean,
  nullableInstant,
} = whatsappFields;
const column = (what: string, name: string) =>
  `${what} (ZWAMESSAGEDATAITEM.${name}).`;

const properties = {
  ...messageKeyFields,
  index: {
    ...integer,
    minimum: 0,
    description: column('The item’s place among the message’s items', 'ZINDEX'),
  },
  type: {
    ...nullableInteger,
    description: column(
      'WhatsApp’s item kind; 0, a link, is the only one seen',
      'ZTYPE',
    ),
  },
  date: {
    ...nullableInstant,
    description: column('WhatsApp’s date of the item, UTC', 'ZDATE'),
  },
  content1: { ...nullableText, description: column('The link', 'ZCONTENT1') },
  content2: {
    ...nullableText,
    description: column('WhatsApp’s second content value', 'ZCONTENT2'),
  },
  title: {
    ...nullableText,
    description: column('The linked page’s title', 'ZTITLE'),
  },
  summary: {
    ...nullableText,
    description: column('The linked page’s description', 'ZSUMMARY'),
  },
  matchedText: {
    ...nullableText,
    description: column(
      'The text WhatsApp matched as the link',
      'ZMATCHEDTEXT',
    ),
  },
  sectionId: {
    ...nullableText,
    description: column(
      'The month WhatsApp lists the link under, YYYY-MM',
      'ZSECTIONID',
    ),
  },
  senderJid: {
    ...nullableJid,
    description: column('WhatsApp’s sender value', 'ZSENDERJID'),
  },
  thumbnailPath: {
    ...nullableText,
    description: column(
      'Where WhatsApp keeps the link’s thumbnail',
      'ZTHUMBNAILPATH',
    ),
  },
  ownsThumbnail: {
    ...nullableBoolean,
    description: column(
      'Whether the item owns that thumbnail',
      'ZOWNSTHUMBNAIL',
    ),
  },
} as const;

export class MessageDataItemsStream extends WhatsAppStream<
  typeof properties,
  MessageDataItem
> {
  readonly name = 'messageDataItems';
  readonly store = 'chatStorage';
  readonly primaryKey = [...messageKeyColumns, 'index'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per link WhatsApp found in a message, as its chat’s Links list shows them, with the linked page’s title and description. Primary key chatJid, messageIsFromMe, messageStanzaId, index.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): readonly MessageDataItem[] {
    return scan.chatStorage.dataItems;
  }

  protected record({
    chatJid,
    isFromMe,
    stanzaId,
    ...item
  }: MessageDataItem): RecordDraft<typeof properties> {
    return { ...messageKeyRecord({ chatJid, isFromMe, stanzaId }), ...item };
  }
}
