import { Argument, type Command as Declaration } from 'commander';
import { table } from '../table.ts';
import { Command, type Output } from './command.ts';

const flag = (scope: 'accountIds' | 'collectionIds') =>
  scope === 'accountIds' ? '--account' : '--collection';

export class OptionsCommand extends Command {
  readonly name = 'options';
  readonly summary =
    "List an app's accounts and collections, for setup's narrowing flags";

  protected configure(declaration: Declaration): void {
    declaration.addArgument(new Argument('<app>').choices(this.appNames));
  }

  protected async run(declaration: Declaration): Promise<Output> {
    const [name] = declaration.processedArgs as [string];
    const app = this.app(name);
    const choices = await app.listChoices().catch((error: unknown) => {
      throw new Error(app.failure(error));
    });
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
