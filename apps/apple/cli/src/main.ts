import { Command as Program } from 'commander';

import { AppleTranscription } from '@workspace/connector-apple-connector/apple-transcription';
import { builtInConnectors } from '@workspace/connector-apple-manifest/built-in-connectors';
import { Connectors } from '@workspace/connector-apple-manifest/connectors';
import { provideHostModules } from '@workspace/connector-apple-manifest/host-modules';
import { userConnectors } from '@workspace/connector-apple-manifest/user-connectors';

import { OptionsCommand } from './commands/options.ts';
import { QueryCommand } from './commands/query.ts';
import { SetupCommand } from './commands/setup.ts';
import { StatusCommand } from './commands/status.ts';
import { SyncCommand } from './commands/sync.ts';
import { Imports } from './imports.ts';
import { TerminalHost } from './terminal-host.ts';

if (process.platform !== 'darwin')
  throw new Error('The Apple connectors read apps on a Mac.');

// The user's own connectors import elt and AppleConnector from this CLI's copies.
provideHostModules(({ specifier }) => import.meta.resolve(specifier));

const program = new Program('apple-cli')
  .description(
    'Import Apple apps on this Mac, keep them current, and query them.',
  )
  .option(
    '--directory <path>',
    'directory for settings and imports',
    'outputs/cli',
  )
  .option(
    '--transcription-model <id>',
    'local audio model installed in Handy: cohere-int8, canary-180m-flash, or off',
  )
  .showHelpAfterError()
  // Each command reads its own options, so sync watch --connector reaches
  // watch rather than sync.
  .enablePositionalOptions()
  .passThroughOptions();

// Read the storage option before constructing the commands' shared imports.
// Commander leaves the command and its arguments for the full parse below.
const { operands, unknown } = program.parseOptions(process.argv.slice(2));
const { directory, transcriptionModel } = program.opts<{
  directory: string;
  transcriptionModel?: string;
}>();
await using transcription = new AppleTranscription(directory);
if (transcriptionModel !== undefined) {
  const { models } = await transcription.choices();
  const chosen = models.find(({ id }) => id === transcriptionModel);
  if (transcriptionModel !== 'off' && chosen === undefined)
    program.error(
      `No installed model named ${transcriptionModel}. Available: ${[...models.map(({ id }) => id), 'off'].join(', ')}.`,
    );
  await transcription.configure(chosen?.configuration ?? null);
} else await transcription.refresh();

const { connectors, broken } = await new Connectors([
  builtInConnectors,
  userConnectors,
]).load(new TerminalHost(() => transcription.parser));

for (const { title, error } of broken)
  process.stderr.write(`${title} could not be loaded: ${error}\n`);

const imports = new Imports(connectors, directory);

for (const command of [
  new SetupCommand(imports),
  new OptionsCommand(imports),
  new SyncCommand(imports),
  new StatusCommand(imports),
  new QueryCommand(imports),
])
  command.attach(program);
await program.parseAsync([...operands, ...unknown], { from: 'user' });
