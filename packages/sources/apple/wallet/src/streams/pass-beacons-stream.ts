import type { RecordDraft } from '@workspace/elt';
import type { Pass } from '@workspace/sdk-apple-wallet';

import { AppleWalletStream, walletFields } from '../apple-wallet-stream.ts';

const { id, text, nullableText, ordinal } = walletFields;

const uint16 = {
  type: ['integer', 'null'],
  minimum: 0,
  maximum: 65535,
} as const;

const properties = {
  passId: { ...id, description: 'The pass it is for; refers to passes.id.' },
  position: {
    ...ordinal,
    description: 'Its place in the pass’s beacons, from 0.',
  },
  proximityUuid: {
    ...text,
    description: 'The Bluetooth beacon’s proximity UUID (proximityUUID).',
  },
  major: {
    ...uint16,
    description:
      'The beacon’s major identifier (major); NULL when any major matches.',
  },
  minor: {
    ...uint16,
    description:
      'The beacon’s minor identifier (minor); NULL when any minor matches.',
  },
  relevantText: {
    ...nullableText,
    description:
      'What the Lock Screen says when the beacon is near (relevantText); NULL when the pass says nothing.',
  },
} as const;

export class PassBeaconsStream extends AppleWalletStream<typeof properties> {
  readonly name = 'passBeacons';
  readonly primaryKey = ['passId', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per Bluetooth beacon near which Wallet offers a pass on the Lock Screen, such as a store’s. Primary key passId, position.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected records(pass: Pass): RecordDraft<typeof properties>[] {
    return pass.beacons.map((beacon) => ({ passId: pass.id, ...beacon }));
  }
}
