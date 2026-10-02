import { Command as Program } from 'commander';

import { Connectors } from '@workspace/apple-manifest/connectors';
import { builtInConnectors } from '@workspace/apple/apps/built-in-connectors';

import { OptionsCommand } from './commands/options.ts';
import { QueryCommand } from './commands/query.ts';
import { SetupCommand } from './commands/setup.ts';
import { StatusCommand } from './commands/status.ts';
import { SyncCommand } from './commands/sync.ts';
import { Imports } from './imports.ts';
import { TerminalHost } from './terminal-host.ts';

if (process.platform !== 'darwin')
  throw new Error('The Apple connectors read apps on a Mac.');

const { apps, broken } = await new Connectors([builtInConnectors]).load(
  new TerminalHost(),
);
for (const { title, error } of broken)
  process.stderr.write(`${title} could not be loaded: ${error}\n`);
const imports = new Imports(apps);
const program = new Program('apple-cli')
  .description(
    'Import Apple apps on this Mac into outputs/cli, keep them current, and query them.',
  )
  .showHelpAfterError();
for (const command of [
  new SetupCommand(imports),
  new OptionsCommand(imports),
  new SyncCommand(imports),
  new StatusCommand(imports),
  new QueryCommand(imports),
])
  command.attach(program);
await program.parseAsync();
