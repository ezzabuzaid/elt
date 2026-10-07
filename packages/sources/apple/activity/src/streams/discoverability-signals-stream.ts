import type { RecordDraft } from '@workspace/elt';
import {
  DiscoverabilitySignals,
  type DiscoverabilitySignalsEvent,
  type KnowledgeEvent,
} from '@workspace/sdk-apple-knowledge';

import { activityFields, plistText } from '../activity-values.ts';
import {
  KnowledgeActivityStream,
  knowledgeEvent,
  knowledgeEventRecord,
} from '../knowledge-activity-stream.ts';

const { nullableText } = activityFields;

const properties = {
  ...knowledgeEvent,
  signal: {
    ...nullableText,
    description:
      'The event the signal reports, such as com.apple.spotlight.invoked.',
  },
  bundleId: {
    ...nullableText,
    description: 'Bundle identifier of the app that reported the signal.',
  },
  osBuild: {
    ...nullableText,
    description: 'macOS build that recorded the signal.',
  },
  userInfo: {
    ...nullableText,
    description:
      'Extra data the signal carried, decoded from its property list to JSON; NULL when none.',
  },
} as const;

export class DiscoverabilitySignalsStream extends KnowledgeActivityStream<
  typeof properties,
  DiscoverabilitySignalsEvent
> {
  readonly name = 'discoverabilitySignals';
  readonly knowledge = new DiscoverabilitySignals();
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per feature-discovery signal on this Mac (knowledgeC /discoverability/signals), the events macOS uses to time its tips. macOS keeps these for two years.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: KnowledgeEvent & DiscoverabilitySignalsEvent,
  ): RecordDraft<typeof properties> {
    return {
      ...knowledgeEventRecord(event),
      signal: event.signal ?? null,
      bundleId: event.bundleId ?? null,
      osBuild: event.osBuild ?? null,
      userInfo: plistText(event.userInfo),
    };
  }
}
