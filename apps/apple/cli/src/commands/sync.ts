import { type Command as Declaration, Option } from 'commander';

import { SyncReport } from '../sync-report.ts';
import { Command, type Output } from './command.ts';

export class SyncCommand extends Command {
  readonly name = 'sync';
  readonly summary = 'Load every selected connector once';

  protected configure(declaration: Declaration): void {
    declaration.addOption(
      new Option(
        '--connector <connector...>',
        'sync only these connectors',
      ).choices(this.imports.names),
    );
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
