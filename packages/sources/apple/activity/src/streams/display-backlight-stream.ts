import type { RecordDraft } from '@workspace/elt';
import {
  DisplayIsBacklit,
  type DisplayIsBacklitEvent,
  type KnowledgeEvent,
} from '@workspace/sdk-apple-knowledge';

import { activityFields } from '../activity-values.ts';
import {
  KnowledgeActivityStream,
  knowledgeEvent,
  knowledgeEventRecord,
} from '../knowledge-activity-stream.ts';

const properties = {
  ...knowledgeEvent,
  backlit: {
    ...activityFields.boolean,
    description:
      'Whether the display was lit between startedAt and endedAt (false: off or asleep).',
  },
} as const;

export class DisplayBacklightStream extends KnowledgeActivityStream<
  typeof properties,
  DisplayIsBacklitEvent
> {
  readonly name = 'displayBacklight';
  readonly knowledge = new DisplayIsBacklit();
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per span the display stayed lit or dark on this Mac (knowledgeC /display/isBacklit): when the screen was on.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: KnowledgeEvent & DisplayIsBacklitEvent,
  ): RecordDraft<typeof properties> {
    return {
      ...knowledgeEventRecord(event),
      backlit: event.backlit ?? null,
    };
  }
}
