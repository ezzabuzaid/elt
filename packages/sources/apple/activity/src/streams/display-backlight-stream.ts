import type { RecordDraft } from '@workspace/elt';

import {
  type Row,
  activityFields,
  appleTime,
  flag,
} from '../activity-values.ts';
import { KnowledgeStream, knowledgeEvent } from '../knowledge-stream.ts';

const properties = {
  ...knowledgeEvent,
  backlit: {
    ...activityFields.boolean,
    description:
      'Whether the display was lit between startedAt and endedAt (false: off or asleep).',
  },
} as const;

export class DisplayBacklightStream extends KnowledgeStream<typeof properties> {
  readonly name = 'displayBacklight';
  readonly streamName = '/display/isBacklit';
  readonly retentionDays = 28;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per span the display stayed lit or dark on this Mac (knowledgeC /display/isBacklit): when the screen was on.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected readonly columns = 'o.ZVALUEINTEGER';

  protected record(row: Row): RecordDraft<typeof properties> {
    return {
      id: row.ZUUID,
      startedAt: appleTime(row.ZSTARTDATE),
      endedAt: appleTime(row.ZENDDATE),
      createdAt: appleTime(row.ZCREATIONDATE),
      utcOffsetSeconds: row.ZSECONDSFROMGMT,
      backlit: flag(row.ZVALUEINTEGER),
    };
  }
}
