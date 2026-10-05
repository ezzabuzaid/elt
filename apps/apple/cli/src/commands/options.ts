import { Argument, type Command as Declaration } from 'commander';

import { table } from '../table.ts';
import { Command, type Output } from './command.ts';

const flag = (scope: 'accountIds' | 'collectionIds') =>
  scope === 'accountIds' ? '--account' : '--collection';

export class OptionsCommand extends Command {
  readonly name = 'options';
  readonly summary =
    "List a connector's accounts and collections, for setup's narrowing flags";

  protected configure(declaration: Declaration): void {
    declaration.addArgument(
      new Argument('<connector>').choices(this.imports.names),
    );
  }

  protected async run(declaration: Declaration): Promise<Output> {
    const name: string = declaration.processedArgs[0];
    const choices = await this.imports.options(name);
    return {
      data: choices.map(({ title, scope, options }) => ({
        title,
        flag: flag(scope),
        options,
      })),
      text: () =>
        table(
          ['Flag', 'ID', 'Name'],
          choices.flatMap(({ scope, options }) =>
            options.map(({ id, label }) => [flag(scope), id, label]),
          ),
        ),
    };
  }
}
