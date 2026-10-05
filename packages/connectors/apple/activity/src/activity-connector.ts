import { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import type { Choice } from '@workspace/connector-apple-connector/choice';
import { AppleActivitySource } from '@workspace/source-apple-activity/apple-activity-source';

export default class ActivityConnector extends AppleConnector {
  readonly datedBy = null;
  readonly fullDiskAccess = true;
  // macOS keeps a few weeks of activity; everything it keeps is imported.
  protected readonly choices: readonly Choice[] = [];
  // A small Biome stream: reading it lists the protected Biome folder.
  protected override readonly probe = 'appMenuItems';
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(): string {
    return 'No app needs to be open: macOS records this activity on its own.';
  }

  protected source() {
    return new AppleActivitySource();
  }
}
