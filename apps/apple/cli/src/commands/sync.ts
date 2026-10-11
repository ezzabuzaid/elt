import { type Command as Declaration, Option } from 'commander';

import { SyncReport } from '../sync-report.ts';
import { Command, type Output } from './command.ts';
import { SyncWatchCommand } from './sync-watch.ts';

export class SyncCommand extends Command {
  readonly name = 'sync';
  readonly summary = 'Load every selected connector once';

  protected configure(declaration: Declaration): void {
    // A copy lives in sync watch's --connector: change both.
    declaration.addOption(
      new Option(
        '--connector <connector...>',
        'sync only these connectors',
      ).choices(this.imports.names),
    );
    new SyncWatchCommand(this.imports).attach(declaration);
  }

  protected async run(
    declaration: Declaration,
    interactive: boolean,
  ): Promise<Output | undefined> {
    const { connector } = declaration.opts<{ connector?: string[] }>();
    await this.imports.sync(connector, new SyncReport(interactive));
    return undefined;
  }
}
