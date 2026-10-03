import { type Command as Declaration, Option } from 'commander';

import { SyncReport } from '../sync-report.ts';
import { Command, type Output } from './command.ts';

export class SyncCommand extends Command {
  readonly name = 'sync';
  readonly summary = 'Load every selected app once';

  protected configure(declaration: Declaration): void {
    declaration.addOption(
      new Option('--app <app...>', 'sync only these apps').choices(
        this.imports.names,
      ),
    );
  }

  protected async run(
    declaration: Declaration,
    interactive: boolean,
  ): Promise<Output | undefined> {
    const { app } = declaration.opts<{ app?: string[] }>();
    await this.imports.sync(app, new SyncReport(interactive));
    return undefined;
  }
}
