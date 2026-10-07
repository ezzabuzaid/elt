import type { CopyConfiguration, SourceMessage, Stream } from '@workspace/elt';
import type { BiomeStream } from '@workspace/sdk-apple-biome';

import type { ActivityScan } from './activity-scan.ts';

// What the source needs from any activity stream: its description, the store
// it reads, and the messages one read yields for a copy. A Biome stream also
// names the Biome stream it reads, whose segments a watch fingerprints.
type Reader = {
  readonly name: string;
  // How long macOS keeps the stream's records; null when it keeps no history.
  readonly retentionDays: number | null;
  describe(): Stream;
  messages(
    configuration: CopyConfiguration,
    state: unknown,
    scan: ActivityScan,
  ): AsyncIterable<SourceMessage>;
};

export type ActivityReader =
  | (Reader & {
      readonly store: 'biome';
      readonly biome: BiomeStream<unknown>;
    })
  | (Reader & { readonly store: 'knowledge' | 'devices' });
