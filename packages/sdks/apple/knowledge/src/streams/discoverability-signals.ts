import type { PlistValue } from '@workspace/codec-plist';

import { type KnowledgeRow, KnowledgeStream } from '../knowledge-stream.ts';
import { archive, optionalText } from '../knowledge-values.ts';

export type DiscoverabilitySignalsEvent = {
  // The event the signal reports, such as com.apple.spotlight.invoked.
  readonly signal: string | undefined;
  readonly bundleId: string | undefined;
  readonly osBuild: string | undefined;
  readonly userInfo: PlistValue | undefined;
};

// A feature-discovery signal macOS times its tips by.
export class DiscoverabilitySignals extends KnowledgeStream<DiscoverabilitySignalsEvent> {
  readonly name = '/discoverability/signals';
  readonly maximumAgeDays = 730;
  readonly columns = {
    ZOBJECT: ['ZVALUESTRING'],
    ZSOURCE: ['ZBUNDLEID'],
    ZSTRUCTUREDMETADATA: [
      'Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__OSBUILD',
      'Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__USERINFO',
    ],
  };

  decode(row: KnowledgeRow): DiscoverabilitySignalsEvent {
    return {
      signal: optionalText(row.ZVALUESTRING),
      bundleId: optionalText(row.ZBUNDLEID),
      osBuild: optionalText(row.Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__OSBUILD),
      userInfo: archive(row.Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__USERINFO),
    };
  }
}
