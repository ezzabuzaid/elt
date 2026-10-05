import type { Command as Declaration } from 'commander';

import type { Imports } from '../imports.ts';
import { json } from '../table.ts';

// What a command shows once it ran: its data as JSON for scripts, or text for
// a person at a terminal.
export type Output = {
  readonly data: unknown;
  text(): string;
};

// The skeleton every command shares. A subclass declares its arguments and
// options and runs; this decides once whether a person is at the terminal,
// shows the output for that audience, and reports a failure as commander
// reports its own, with exit status 1.
export abstract class Command {
  abstract readonly name: string;
  abstract readonly summary: string;

  // Every command reaches the connectors and their imports through the
  // mediator.
  protected readonly imports: Imports;

  constructor(imports: Imports) {
    this.imports = imports;
  }

  protected abstract configure(declaration: Declaration): void;

  // Commands that show their own progress, such as sync, return nothing.
  // interactive: a person is at the terminal and may be prompted; otherwise
  // output is JSON and nothing prompts.
  protected abstract run(
    declaration: Declaration,
    interactive: boolean,
  ): Promise<Output | undefined>;

  attach(program: Declaration): void {
    const declaration = program
      .command(this.name)
      .description(this.summary)
      .option('--json', 'print JSON and never prompt');
    this.configure(declaration);
    declaration.action(async () => {
      const interactive =
        declaration.opts().json !== true &&
        process.stdin.isTTY === true &&
        process.stdout.isTTY === true;
      try {
        const output = await this.run(declaration, interactive);
        if (output !== undefined)
          process.stdout.write(
            `${interactive ? output.text() : json(output.data, 2)}\n`,
          );
      } catch (error) {
        declaration.error(
          `error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }
}
