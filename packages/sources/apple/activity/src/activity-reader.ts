import type { CopyConfiguration, SourceMessage, Stream } from '@workspace/elt';

import type { ActivityScan, ActivityStore } from './activity-scan.ts';

// What the source needs from any activity stream: its description, the store
// it reads, and the messages one read yields for a copy.
export type ActivityReader = {
  readonly name: string;
  readonly store: ActivityStore;
  // How long macOS keeps the stream's records; null when it keeps no history.
  readonly retentionDays: number | null;
  describe(): Stream;
  messages(
    configuration: CopyConfiguration,
    state: unknown,
    scan: ActivityScan,
  ): AsyncIterable<SourceMessage>;
};
