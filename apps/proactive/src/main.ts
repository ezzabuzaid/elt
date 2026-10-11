import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { builtInConnectors } from '@workspace/connector-apple-manifest/built-in-connectors';
import { Connectors } from '@workspace/connector-apple-manifest/connectors';
import { Eca } from '@workspace/eca';
import { SQLiteSyncHistory } from '@workspace/elt-sqlite';
import { type Selection, Settings } from '@workspace/settings';

import { EarlyMonthSpend } from './early-month-spend.ts';
import { ImportWarehouse, type Query } from './import-warehouse.ts';

if (process.platform !== 'darwin')
  throw new Error('proactive reads Apple apps on a Mac.');

// proactive's own imports, apart from the Apple plugin's and the CLI's.
const root = join(
  homedir(),
  'Library/Application Support/Context Compiler/Proactive',
);

const { connectors, broken } = await new Connectors([builtInConnectors]).load({
  // macOS grants access, such as Full Disk Access for Messages, to the
  // terminal that runs proactive.
  grantee: 'the terminal that runs proactive',
  eventKitHelper: fileURLToPath(
    new URL(
      'eventkit-helper',
      import.meta.resolve('@workspace/sdk-apple-eventkit'),
    ),
  ),
});
for (const { title, error } of broken)
  process.stderr.write(`${title} could not be loaded: ${error}\n`);
const connector = (name: string) => {
  const loaded = connectors.find((candidate) => candidate.name === name);
  if (loaded === undefined) throw new Error(`Unknown connector ${name}`);
  return loaded;
};

// Every built-in connector with all its records. Rules read rows, not files,
// so no attachment is copied.
using settings = new Settings(root);
const selections = connectors.map(({ name }) => ({
  connector: name,
  scope: {},
  includeAttachments: false,
}));
settings.select(selections, {
  facts: connector,
  permissions: (selection) => connector(selection.connector).guidance(),
});
// One pass of each selection, side by side. A connector that cannot connect
// says why, and the others still import.
const pass = async (selected: readonly Selection[]) => {
  await Promise.all(
    selected.map(async (selection) => {
      const importing = connector(selection.connector);
      const outcome = await importing.import(
        settings,
        selection,
        new SQLiteSyncHistory(),
      );
      if (outcome.status === 'unconnected')
        process.stderr.write(
          `${importing.title}: ${importing.failure(outcome.error)}\n`,
        );
    }),
  );
};
// A rule starts from what the imports held before this run's pass, so an
// import that does not exist yet is made first, and tells nothing.
await pass(
  selections.filter((selection) => !existsSync(settings.database(selection))),
);

using warehouse = new ImportWarehouse(
  Object.fromEntries(
    selections
      .filter((selection) => existsSync(settings.database(selection)))
      .map((selection) => [selection.connector, settings.database(selection)]),
  ),
  () => pass(selections),
);
const eca = new Eca<Query, { spent: number }>({ warehouse });
const spend = { condition: new EarlyMonthSpend() };
eca.add(spend);

const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => stop.abort());

const run = promisify(execFile);
for await (const match of eca.watch({ signal: stop.signal }))
  if (match.rule === spend)
    await run('/usr/bin/osascript', [
      '-e',
      'on run argv',
      '-e',
      'display notification (item 1 of argv) with title "Proactive"',
      '-e',
      'end run',
      `You spent ${match.data.spent} JOD in the first 10 days of ${match.key}.`,
    ]);
