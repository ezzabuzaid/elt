import type { RecordDraft } from '@eltjs/elt';
import type { BusinessBotPrompt } from '@eltjs/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, rowId, whatsappFields } from '../whatsapp-stream.ts';

const { jid, text, integer, nullableText } = whatsappFields;

const properties = {
  id: rowId('ZWABIZBOTPROMPTDATA'),
  profileId: {
    ...integer,
    description: 'The business profile; refers to businessProfiles.id.',
  },
  jid: { ...jid, description: 'The business’s JID (businessProfiles.jid).' },
  text: {
    ...text,
    minLength: 1,
    description:
      'The question the chat offers to start with (ZWABIZBOTPROMPTDATA.ZTEXT).',
  },
  position: {
    ...integer,
    minimum: 0,
    description: 'The prompt’s place among the business’s prompts.',
  },
  emoji: { ...nullableText, description: 'The prompt’s emoji (ZEMOJI).' },
} as const;

export class BusinessBotPromptsStream extends WhatsAppStream<
  typeof properties,
  BusinessBotPrompt
> {
  readonly name = 'businessBotPrompts';
  readonly store = 'businesses';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per suggested question a business’s automated agent offers in its chat. Primary key id. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): Iterable<BusinessBotPrompt> {
    return scan.businesses.botPrompts();
  }

  protected record(prompt: BusinessBotPrompt): RecordDraft<typeof properties> {
    return { ...prompt };
  }
}
