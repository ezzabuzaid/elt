import { type Command as Declaration, Option } from 'commander';

import { WatchReport } from '../watch-report.ts';
import { Command, type Output } from './command.ts';

export class SyncWatchCommand extends Command {
  readonly name = 'watch';
  readonly summary =
    'Keep every selected connector current as it changes, until stopped';

  protected configure(declaration: Declaration): void {
    // A copy of sync's --connector: change both. A third command that names
    // connectors to run moves it into one place.
    declaration.addOption(
      new Option(
        '--connector <connector...>',
        'watch only these connectors',
      ).choices(this.imports.names),
    );
  }

  protected async run(
    declaration: Declaration,
    interactive: boolean,
  ): Promise<Output | undefined> {
    const { connector } = declaration.opts<{ connector?: string[] }>();
    await this.imports.watch(connector, new WatchReport(interactive));
    return undefined;
  }
}
