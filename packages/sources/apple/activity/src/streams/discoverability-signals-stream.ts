import type { RecordDraft } from '@workspace/elt';

import {
  type Row,
  activityFields,
  appleTime,
  archiveJSON,
  nonEmpty,
} from '../activity-values.ts';
import { KnowledgeStream, knowledgeEvent } from '../knowledge-stream.ts';

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

export class DiscoverabilitySignalsStream extends KnowledgeStream<
  typeof properties
> {
  readonly name = 'discoverabilitySignals';
  readonly streamName = '/discoverability/signals';
  readonly retentionDays = 730;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per feature-discovery signal on this Mac (knowledgeC /discoverability/signals), the events macOS uses to time its tips. macOS keeps these for two years.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected readonly columns = `o.ZVALUESTRING, s.ZBUNDLEID,
    m.Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__OSBUILD, m.Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__USERINFO`;

  protected record(row: Row): RecordDraft<typeof properties> {
    return {
      id: row.ZUUID,
      startedAt: appleTime(row.ZSTARTDATE),
      endedAt: appleTime(row.ZENDDATE),
      createdAt: appleTime(row.ZCREATIONDATE),
      utcOffsetSeconds: row.ZSECONDSFROMGMT,
      signal: nonEmpty(row.ZVALUESTRING),
      bundleId: nonEmpty(row.ZBUNDLEID),
      osBuild: nonEmpty(row.Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__OSBUILD),
      userInfo: archiveJSON(
        row.Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__USERINFO,
      ),
    };
  }
}
