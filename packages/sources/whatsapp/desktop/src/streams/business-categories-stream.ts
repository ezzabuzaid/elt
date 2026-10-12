import type { RecordDraft } from '@workspace/elt';
import type { BusinessCategory } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { jid, text, integer, nullableText } = whatsappFields;

const properties = {
  jid: { ...jid, description: 'The business; refers to businessProfiles.jid.' },
  categoryId: {
    ...text,
    minLength: 1,
    description: 'WhatsApp’s category ID (ZWABIZCATEGORYDATA.ZCATEGORYID).',
  },
  position: {
    ...integer,
    minimum: 0,
    description: 'The category’s place in the profile; 0 is the main one.',
  },
  name: { ...nullableText, description: 'The category’s name (ZNAME).' },
} as const;

export class BusinessCategoriesStream extends WhatsAppStream<
  typeof properties,
  BusinessCategory
> {
  readonly name = 'businessCategories';
  readonly store = 'businesses';
  readonly primaryKey = ['jid', 'categoryId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per category a business profile lists. Primary key jid, categoryId. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): readonly BusinessCategory[] {
    return scan.businesses.categories();
  }

  protected record(category: BusinessCategory): RecordDraft<typeof properties> {
    return { ...category };
  }
}
