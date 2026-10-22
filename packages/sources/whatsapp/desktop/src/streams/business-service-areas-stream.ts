import type { RecordDraft } from '@workspace/elt';
import type { BusinessServiceArea } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { jid, integer, nullableNumber, nullableText } = whatsappFields;

const properties = {
  jid: { ...jid, description: 'The business; refers to businessProfiles.jid.' },
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
  readonly primaryKey = ['jid', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per area a business profile says it serves. Areas have no ID, so the key is their place in the list: primary key jid, position. Not narrowed by an import’s chats or dates.',
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
