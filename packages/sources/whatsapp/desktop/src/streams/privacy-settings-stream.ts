import type { RecordDraft } from '@workspace/elt';
import type { PrivacySetting } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { text } = whatsappFields;

const properties = {
  category: {
    ...text,
    minLength: 1,
    description:
      'What the setting covers, as WhatsApp names it: last (last seen), online, profile (photo), status (About), groupadd, calladd, messages, stickers, linked_profiles, cover_photo, defense; the primary key.',
  },
  value: {
    ...text,
    description:
      'Who it allows, as WhatsApp names it: all, contacts, none, match_last_seen, or on or off.',
  },
} as const;

export class PrivacySettingsStream extends WhatsAppStream<
  typeof properties,
  PrivacySetting
> {
  readonly name = 'privacySettings';
  readonly store = 'localKeyValue';
  readonly primaryKey = ['category'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per privacy setting of this account, as WhatsApp last fetched them (LocalKeyValue.sqlite’s privacy-settings-values). Read receipts are a preference WhatsApp keeps elsewhere and are not here. Primary key category. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): Iterable<PrivacySetting> {
    return scan.localKeyValue.privacySettings();
  }

  protected record(setting: PrivacySetting): RecordDraft<typeof properties> {
    return { ...setting };
  }
}
