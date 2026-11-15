import type { RecordDraft } from '@eltjs/elt';
import type { BusinessServiceArea } from '@eltjs/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, rowId, whatsappFields } from '../whatsapp-stream.ts';

const { jid, integer, nullableNumber, nullableText } = whatsappFields;

const properties = {
  id: rowId('ZWABIZSERVICEAREADATA'),
  profileId: {
    ...integer,
    description: 'The business profile; refers to businessProfiles.id.',
  },
  jid: { ...jid, description: 'The business’s JID (businessProfiles.jid).' },
  position: {
    ...integer,
    minimum: 0,
    description: 'The area’s place in the profile’s list.',
  },
  latitude: {
    ...nullableNumber,
    description: 'The area’s center (ZWABIZSERVICEAREADATA.ZLATITUDE).',
  },
  longitude: {
    ...nullableNumber,
    description: 'The area’s center (ZLONGITUDE).',
  },
  radiusMeters: {
    ...nullableNumber,
    minimum: 0,
    description: 'The area’s radius in meters (ZAREARADIUSMETERS).',
  },
  description: {
    ...nullableText,
    description: 'The area as the business describes it (ZAREADESCRIPTION).',
  },
} as const;

export class BusinessServiceAreasStream extends WhatsAppStream<
  typeof properties,
  BusinessServiceArea
> {
  readonly name = 'businessServiceAreas';
  readonly store = 'businesses';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per area a business profile says it serves. Primary key id. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): Iterable<BusinessServiceArea> {
    return scan.businesses.serviceAreas();
  }

  protected record(area: BusinessServiceArea): RecordDraft<typeof properties> {
    return { ...area };
  }
}
