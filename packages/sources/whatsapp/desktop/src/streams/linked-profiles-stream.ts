import type { RecordDraft } from '@workspace/elt';
import type { LinkedProfile } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { jid, text, nullableText } = whatsappFields;

const properties = {
  lid: { ...jid, description: 'The person, by LID; refers to users.lid.' },
  type: {
    ...text,
    minLength: 1,
    description: 'The service, such as INSTAGRAM.',
  },
  username: { ...nullableText, description: 'Their name on it.' },
  url: { ...nullableText, description: 'Their profile’s address on it.' },
} as const;

export class LinkedProfilesStream extends WhatsAppStream<
  typeof properties,
  LinkedProfile
> {
  readonly name = 'linkedProfiles';
  readonly store = 'localKeyValue';
  readonly primaryKey = ['lid', 'type'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per account on another service a person links to their WhatsApp profile (LocalKeyValue.sqlite’s linked-profiles). Primary key lid, type. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): readonly LinkedProfile[] {
    return scan.localKeyValue.linkedProfiles();
  }

  protected record(profile: LinkedProfile): RecordDraft<typeof properties> {
    return { ...profile };
  }
}
