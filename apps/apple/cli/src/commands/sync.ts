import { type Command as Declaration, Option } from 'commander';

import { SyncReport } from '../sync-report.ts';
import { Command, type Output } from './command.ts';

export class SyncCommand extends Command {
  readonly name = 'sync';
  readonly summary =
    'Load every selected app once, or keep them current with --watch';

  protected configure(declaration: Declaration): void {
    declaration
      .addOption(
        new Option('--app <app...>', 'sync only these apps').choices(
          this.imports.names,
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
    await this.imports.sync(
      app,
      watch === true,
      new SyncReport(interactive, watch === true),
    );
    return undefined;
  }
}
