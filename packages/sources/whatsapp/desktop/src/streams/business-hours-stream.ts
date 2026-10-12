import type { RecordDraft } from '@workspace/elt';
import type { BusinessHours } from '@workspace/sdk-whatsapp-desktop';

import { unique } from '../chat-storage-records.ts';
import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { jid, integer } = whatsappFields;
const minutes = { ...integer, minimum: 0, maximum: 1440 } as const;

const properties = {
  jid: { ...jid, description: 'The business; refers to businessProfiles.jid.' },
  day: {
    ...integer,
    minimum: 1,
    maximum: 7,
    description: 'The day, 1 Sunday through 7 Saturday.',
  },
  openTime: {
    ...minutes,
    description:
      'When it opens, in minutes after midnight in the business’s time zone; 0 when open all day or by appointment.',
  },
  mode: {
    ...integer,
    description:
      'How it keeps the day: 0 open all day, 1 set hours, 2 by appointment only.',
  },
  closeTime: {
    ...minutes,
    description: 'When it closes, in minutes after midnight.',
  },
} as const;

export class BusinessHoursStream extends WhatsAppStream<
  typeof properties,
  BusinessHours
> {
  readonly name = 'businessHours';
  readonly store = 'businesses';
  readonly primaryKey = ['jid', 'day', 'openTime'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per opening a business profile lists for a day of the week (ZWABIZPROFILEDATA.ZHOURSCONFIGS); a day it is closed has none. Primary key jid, day, openTime; a profile that repeats a day’s hours lists them once. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): readonly BusinessHours[] {
    // A few profiles list one day's hours twice.
    return unique(scan.businesses.hours(), ({ jid, day, openTime }) =>
      JSON.stringify([jid, day, openTime]),
    );
  }

  protected record(hours: BusinessHours): RecordDraft<typeof properties> {
    return { ...hours };
  }
}
