import { log } from '@clack/prompts';

import type { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';

import type { WatchObserver } from './imports.ts';
import { SyncReport } from './sync-report.ts';

// Shows a watch as a sync report shows a sync, with the spinner saying it
// watches between passes, and a line for each import it waits to own while
// another process does and for each whose watch stopped on its own. Without a
// terminal, a JSON line for each.
export class WatchReport extends SyncReport implements WatchObserver {
  protected override readonly idle = 'Watching for changes';
  protected override readonly spinsWhenIdle = true;
  protected override readonly interruption = 'Stopped watching';

  waiting({ name, title }: AppleConnector): void {
    this.line({ connector: name, status: 'waiting' }, () =>
      log.info(`${title.padEnd(10)} another sync owns it · waiting to watch…`),
    );
  }

  stopped({ name, title }: AppleConnector): void {
    this.line({ connector: name, status: 'stopped' }, () =>
      log.info(`${title.padEnd(10)} stopped watching`),
    );
  }

  protected override closing(): string {
    return 'Stopped watching.';
  }
}
