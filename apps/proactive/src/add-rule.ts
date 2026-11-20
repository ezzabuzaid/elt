import { mkdir, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { PostgresDestination } from '@eltjs/elt-postgresql';

import { addRule } from './engine/add-rule.ts';
import { RuleStore } from './engine/rule-store.ts';
import { rulesFile, rulesFolder } from './rules-file.ts';
import { readerUrl } from './warehouse.ts';

// `npx nx run proactive:add-rule <rule.yaml>` keeps the rule that a YAML or
// JSON file holds, once it has read the warehouse as it is now, and prints
// what the rule finds true now.
const {
  positionals: [file],
} = parseArgs({ allowPositionals: true });
if (file === undefined) {
  process.stderr.write('Usage: npx nx run proactive:add-rule <rule.yaml>\n');
  process.exit(2);
}

const reading = await new PostgresDestination({ url: readerUrl }).reading();
if ('expired' in reading) {
  throw new Error(`The warehouse cannot be read: ${reading.expired}`);
}
await using _reading = reading;
await mkdir(rulesFolder, { recursive: true });
using store = new RuleStore(rulesFile);
const lines = await addRule(await readFile(file, 'utf8'), reading, store);
for (const line of lines) process.stdout.write(`${line}\n`);
process.stdout.write(
  `Kept the rule. ${lines.length} rows are true now; it tells only what becomes true after its first run.\n`,
);
