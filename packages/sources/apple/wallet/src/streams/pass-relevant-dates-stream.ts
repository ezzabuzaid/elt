import type { RecordDraft } from '@workspace/elt';
import type { Pass } from '@workspace/sdk-apple-wallet';

import { AppleWalletStream, walletFields } from '../apple-wallet-stream.ts';

const { id, ordinal, passInstant, offset } = walletFields;

const properties = {
  passId: { ...id, description: 'The pass it is for; refers to passes.id.' },
  position: {
    ...ordinal,
    description: 'Its place in the pass’s relevantDates, from 0.',
  },
  at: {
    ...passInstant,
    description:
      'The moment the pass is relevant (date), in UTC; NULL when the entry gives an interval instead.',
  },
  atOffset: {
    ...offset,
    description:
      'The offset from UTC, in minutes, that date was written with; NULL when at is.',
  },
  startsAt: {
    ...passInstant,
    description:
      'When the interval the pass is relevant in starts (startDate), in UTC; NULL when the entry gives a moment.',
  },
  startsAtOffset: {
    ...offset,
    description:
      'The offset from UTC, in minutes, that startDate was written with; NULL when startsAt is.',
  },
  endsAt: {
    ...passInstant,
    description:
      'When that interval ends (endDate), in UTC; NULL when the entry gives a moment.',
  },
  endsAtOffset: {
    ...offset,
    description:
      'The offset from UTC, in minutes, that endDate was written with; NULL when endsAt is.',
  },
} as const;

export class PassRelevantDatesStream extends AppleWalletStream<
  typeof properties
> {
  readonly name = 'passRelevantDates';
  readonly primaryKey = ['passId', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per time a pass made for iOS 18 or later says it is relevant (relevantDates), when Wallet offers it on the Lock Screen: a moment or an interval. Older passes give one moment, passes.relevantAt. Primary key passId, position.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected records(pass: Pass): RecordDraft<typeof properties>[] {
    return pass.relevantDates.map((relevant) => ({
      passId: pass.id,
      position: relevant.position,
      at: relevant.date?.at ?? null,
      atOffset: relevant.date?.offsetMinutes ?? null,
      startsAt: relevant.startDate?.at ?? null,
      startsAtOffset: relevant.startDate?.offsetMinutes ?? null,
      endsAt: relevant.endDate?.at ?? null,
      endsAtOffset: relevant.endDate?.offsetMinutes ?? null,
    }));
  }
}
