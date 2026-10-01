import { type Command as Declaration, Option } from 'commander';
import type { AppleApp } from '../apps/apple-app.ts';
import type { Store } from '../store.ts';
import { sync } from '../sync.ts';
import { SyncReport } from '../sync-report.ts';
import { Command, type Output } from './command.ts';

export class SyncCommand extends Command {
  readonly name = 'sync';
  readonly summary =
    'Load every selected app once, or keep them current with --watch';

  constructor(
    apps: readonly AppleApp[],
    readonly store: Store,
  ) {
    super(apps);
  }

  protected configure(declaration: Declaration): void {
    declaration
      .addOption(
        new Option('--app <app...>', 'sync only these apps').choices(
          this.appNames,
        ),
      )
      .option('--watch', 'keep syncing as each app changes, until stopped');
  }

  protected async run(
    declaration: Declaration,
    interactive: boolean,
  ): Promise<Output | undefined> {
    const { app, watch } = declaration.opts<{
      app?: string[];
      watch?: true;
    }>();
    await this.sync(app, watch === true, interactive);
    return undefined;
  }

  // Also run by setup --sync.
  async sync(
    only: readonly string[] | undefined,
    watch: boolean,
    interactive: boolean,
  ): Promise<void> {
    const selected = this.store.selections().map(({ app }) => app);
    if (selected.length === 0)
      throw new Error('No apps are set up; run: setup');
    for (const name of only ?? [])
      if (!selected.includes(name))
        throw new Error(`${name} is not set up; run: setup`);
    // Ctrl-C stops a sync, watching or not, at once: what it committed stays,
    // its checkpoints resume it, and status shows the pass as interrupted. In
    // a terminal clack's spinner takes Ctrl-C itself and exits with 0, so the
    // status is set as the process exits.
    const interrupted = () => {
      process.exitCode = 130;
    };
    process.on('exit', interrupted);
    process.once('SIGINT', () => process.exit(130));
    process.once('SIGTERM', () => process.exit(130));
    const report = new SyncReport(interactive, watch);
    report.start();
    try {
      await sync(
        this.store,
        (only ?? selected).map((name) => this.app(name)),
        watch,
        report,
      );
    } finally {
      process.off('exit', interrupted);
    }
    report.finish();
    process.exitCode = report.exitCode;
  }
}
