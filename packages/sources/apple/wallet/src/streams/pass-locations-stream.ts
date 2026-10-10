import type { RecordDraft } from '@workspace/elt';
import type { Pass } from '@workspace/sdk-apple-wallet';

import { AppleWalletStream, walletFields } from '../apple-wallet-stream.ts';

const { id, nullableText, ordinal, nullableNumber } = walletFields;

const properties = {
  passId: { ...id, description: 'The pass it is for; refers to passes.id.' },
  position: {
    ...ordinal,
    description: 'Its place in the pass’s locations, from 0.',
  },
  latitude: {
    type: 'number',
    minimum: -90,
    maximum: 90,
    description: 'Latitude in degrees (latitude).',
  },
  longitude: {
    type: 'number',
    minimum: -180,
    maximum: 180,
    description: 'Longitude in degrees (longitude).',
  },
  altitude: {
    ...nullableNumber,
    description: 'Altitude in meters (altitude); NULL when not given.',
  },
  relevantText: {
    ...nullableText,
    description:
      'What the Lock Screen says when the holder is near (relevantText); NULL when the pass says nothing.',
  },
} as const;

export class PassLocationsStream extends AppleWalletStream<typeof properties> {
  readonly name = 'passLocations';
  readonly primaryKey = ['passId', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per place where Wallet offers a pass on the Lock Screen, such as a store or a venue. Primary key passId, position.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected records(pass: Pass): RecordDraft<typeof properties>[] {
    return pass.locations.map((location) => ({
      passId: pass.id,
      ...location,
    }));
  }
}
