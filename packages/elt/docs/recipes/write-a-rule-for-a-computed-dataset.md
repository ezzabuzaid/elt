# Recipe: Write a rule and a table rule, and compute a dataset with them

**Use case.** A host loads the texts that a bank sends. It wants the amount that each text charges, and the sentences of each text with where each one starts and ends, as tables that it can query with SQL. A rule gives one output for each text. A table rule gives one or more parts for each text. Without a computed dataset, the host must find by itself which texts changed, and which outputs to make again or to delete.

**What you need.** `@eltjs/elt` for `Rule`, `TableRule` and `IterableSource`, and `@eltjs/elt-sqlite` for `ComputedDataset`. No server and no model: the destination is a SQLite file.

## The steps

1. Declare the rule columns of the rule in an object `as const`. Give each column its kind and a description.
2. Write a class that extends `Rule<Input, Columns>`. Give it `key`, `output`, `batch`, `concurrency`, `read(row)`, `identity(input)` and `compute(inputs, signal)`.
3. For parts, write a class that extends `TableRule<Input, Columns, Place>`. Give it the same members, and `place` for the place columns of each part.
4. Declare a `ComputedDataset` for each rule in `derived` of the pipeline. Give it the target of the copy in `from`, and the rule in `compute`.
5. Run the pipeline. Query the view `<name>` for the output rows, and the view `<name>_parts` for the parts of a table rule.

## The program

The program loads three bank texts with an `IterableSource` ([ADR 0033](../adr/0033-a-host-loads-the-rows-it-holds-through-an-iterable-source.md)). The rule `Charges` reads the amount of each text, and the table rule `Sentences` cuts each text into sentences. Then the host changes one text, and the program runs the pipeline again. This program ran as a temporary file in `packages/elt`, as rule 7 of the docs guide says.

```ts title="bank-texts.ts"
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { TemporaryFiles } from '@zukhruf/fs';

import {
  Connection,
  Copy,
  IterableSource,
  type LoadedRow,
  Pipeline,
  Rule,
  type RuleResult,
  type RuleValues,
  TableRule,
  type TableRuleResult,
} from '@eltjs/elt';
import {
  ComputedDataset,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@eltjs/elt-sqlite';

// The input of both rules: the text of one loaded row.
function readText(row: LoadedRow) {
  const { id, text } = row;
  return typeof id === 'string' && typeof text === 'string'
    ? { key: id, input: text }
    : null;
}

const charge = {
  amount: { type: 'text', description: 'The amount, as a decimal number.' },
  currency: { type: 'text', description: 'The ISO 4217 code of the amount.' },
} as const;

// The amount that each bank text charges. A text with no amount, such as a
// one-time code, has no charge.
class Charges extends Rule<string, typeof charge> {
  override readonly key = { name: 'id', description: 'The id of the text.' };
  override readonly output = charge;
  // Reading a text takes microseconds: one call takes many texts.
  override readonly batch = 100;
  override readonly concurrency = 1;

  override read(row: LoadedRow) {
    return readText(row);
  }

  override async identity() {
    return 'charges@1';
  }

  override async compute(
    texts: readonly string[],
  ): Promise<readonly RuleResult<RuleValues<typeof charge>>[]> {
    console.log(`Charges: ${texts.length} input(s)`);
    return texts.map((text) => {
      const found = /(\d+\.\d{2}) ([A-Z]{3})/.exec(text);
      if (found === null) return { empty: true };
      const [, amount, currency] = found;
      if (currency !== 'JOD' && currency !== 'USD')
        return { error: `The currency ${currency} is not JOD or USD.` };
      return { value: { amount, currency } };
    });
  }
}

const sentence = {
  text: { type: 'text', description: 'The text of the sentence.' },
} as const;
const place = {
  start: {
    type: 'integer',
    description: 'Where the sentence starts in the text.',
  },
  end: {
    type: 'integer',
    description: 'Where the sentence ends in the text.',
  },
} as const;

// The sentences of each bank text, with where each one starts and ends.
class Sentences extends TableRule<string, typeof sentence, typeof place> {
  override readonly key = { name: 'id', description: 'The id of the text.' };
  override readonly output = sentence;
  override readonly place = place;
  override readonly batch = 100;
  override readonly concurrency = 1;
  readonly #segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

  override read(row: LoadedRow) {
    return readText(row);
  }

  override async identity() {
    return 'sentences@1';
  }

  override async compute(
    texts: readonly string[],
  ): Promise<
    readonly TableRuleResult<
      RuleValues<typeof sentence> & RuleValues<typeof place>
    >[]
  > {
    console.log(`Sentences: ${texts.length} input(s)`);
    return texts.map((text) => {
      const [first, ...rest] = Array.from(
        this.#segmenter.segment(text),
        ({ segment, index }) => {
          const text = segment.trimEnd();
          return { text, start: index, end: index + text.length };
        },
      );
      return first === undefined
        ? { empty: true }
        : { parts: [first, ...rest] };
    });
  }
}

// The texts that the host holds. A real host reads them from its own store.
let texts = [
  { id: 'm1', text: 'Purchase of 12.50 JOD at Carrefour. Balance 300.00 JOD.' },
  { id: 'm2', text: 'Your code is 4471. Do not share it.' },
  { id: 'm3', text: 'Purchase of 9.99 EUR at Spotify.' },
];

const source = new IterableSource({
  identity: 'bank-texts',
  streams: {
    texts: {
      description: 'Each text that the bank sent.',
      jsonSchema: {
        type: 'object',
        description: 'A bank text.',
        properties: {
          id: { type: 'string', description: 'The id of the text.' },
          text: { type: 'string', description: 'The text.' },
        },
        required: ['id', 'text'],
      },
      primaryKey: ['id'],
      deletions: 'closed-world',
      snapshot: () => texts,
    },
  },
});

await using directory = await new TemporaryFiles().directory('bank-texts-');
const sqlite = new SQLiteDestination({
  path: join(directory.path, 'bank.sqlite'),
});
const table = sqlite.table('texts');
const pipeline = new Pipeline({
  history: new SQLiteSyncHistory(),
  clock: globalThis,
  connections: [
    new Connection({
      name: 'bank',
      source,
      destination: sqlite,
      steps: [
        new Copy(source.streams.texts, table, {
          syncMode: 'full_refresh',
          destinationSyncMode: 'overwrite_dedup',
        }),
      ],
    }),
  ],
  derived: [
    new ComputedDataset({
      into: sqlite,
      name: 'charges',
      description: 'The amount that each bank text charges.',
      from: [table],
      compute: new Charges(),
    }),
    new ComputedDataset({
      into: sqlite,
      name: 'sentences',
      description: 'The sentences of each bank text.',
      from: [table],
      compute: new Sentences(),
    }),
  ],
});

const show = () => {
  using database = new DatabaseSync(sqlite.path, { readOnly: true });
  const query = (sql: string) =>
    database
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  console.log(
    query(
      'SELECT id, status, amount, currency, error FROM charges ORDER BY id',
    ),
  );
  console.log(
    query(
      'SELECT id, seq, text, start, end FROM sentences_parts ORDER BY id, seq',
    ),
  );
};

await pipeline.run();
show();

// The host changes one text. Only that text is computed again.
texts = [
  texts[0],
  { id: 'm2', text: 'Purchase of 3.00 USD at Uber.' },
  texts[2],
];
await pipeline.run();
show();
```

Output:

```
Charges: 3 input(s)
Sentences: 3 input(s)
[
  {
    id: 'm1',
    status: 'computed',
    amount: '12.50',
    currency: 'JOD',
    error: null
  },
  {
    id: 'm2',
    status: 'empty',
    amount: null,
    currency: null,
    error: null
  },
  {
    id: 'm3',
    status: 'failed',
    amount: null,
    currency: null,
    error: 'The currency EUR is not JOD or USD.'
  }
]
[
  {
    id: 'm1',
    seq: 0,
    text: 'Purchase of 12.50 JOD at Carrefour.',
    start: 0,
    end: 35
  },
  { id: 'm1', seq: 1, text: 'Balance 300.00 JOD.', start: 36, end: 55 },
  { id: 'm2', seq: 0, text: 'Your code is 4471.', start: 0, end: 18 },
  { id: 'm2', seq: 1, text: 'Do not share it.', start: 19, end: 35 },
  {
    id: 'm3',
    seq: 0,
    text: 'Purchase of 9.99 EUR at Spotify.',
    start: 0,
    end: 32
  }
]
Charges: 1 input(s)
Sentences: 1 input(s)
Charges: 1 input(s)
[
  {
    id: 'm1',
    status: 'computed',
    amount: '12.50',
    currency: 'JOD',
    error: null
  },
  {
    id: 'm2',
    status: 'computed',
    amount: '3.00',
    currency: 'USD',
    error: null
  },
  {
    id: 'm3',
    status: 'failed',
    amount: null,
    currency: null,
    error: 'The currency EUR is not JOD or USD.'
  }
]
[
  {
    id: 'm1',
    seq: 0,
    text: 'Purchase of 12.50 JOD at Carrefour.',
    start: 0,
    end: 35
  },
  { id: 'm1', seq: 1, text: 'Balance 300.00 JOD.', start: 36, end: 55 },
  {
    id: 'm2',
    seq: 0,
    text: 'Purchase of 3.00 USD at Uber.',
    start: 0,
    end: 29
  },
  {
    id: 'm3',
    seq: 0,
    text: 'Purchase of 9.99 EUR at Spotify.',
    start: 0,
    end: 32
  }
]
```

## What the output shows

- **One output row for each key.** `charges` has one row for each text, with its status. The text `m1` gives a value. The one-time code `m2` gives `{ empty: true }`, so its row is `empty` and has no amount. The text `m3` gives `{ error }`: a rule failure is the output of its input, and the run continues ([ADR 0004](../adr/0004-a-rule-failure-stays-on-its-output.md)).
- **One row for each part.** `sentences_parts` has the parts of each text, in order: `seq` from 0, the content column `text`, and the place columns `start` and `end`. The view `sentences` has one output row for each text, with no rule column ([ADR 0026](../adr/0026-a-rule-can-give-many-parts-for-one-input.md), [elt-sqlite: The parts table](../../../destinations/sqlite/README.md#the-parts-table)).
- **A refresh makes again only what changed.** In the second run, each rule computes one input: the text `m2`, whose input changed. The output of `m1` stays as it was. The input of `m2` now has one sentence, so its part with `seq` 1 is deleted ([elt-sqlite ADR 0002](../../../destinations/sqlite/docs/adr/0002-a-computed-dataset-keeps-one-output-row-for-each-key.md)).
- **A failed input is tried again once for each pass.** The second `Charges: 1 input(s)` is the text `m3`. The refresh after the passes tries each `failed` row again, at most once for each pass, so the first run did not try it again ([elt-sqlite ADR 0007](../../../destinations/sqlite/docs/adr/0007-each-pass-tries-an-input-at-most-once.md)). It fails again with the same error, so its row stays as it is.

## Things to know

- **`read(row)` gives the key and the input of one loaded row, or `null`.** A row with no input, such as an attachment row with no stored file, has no output row. `key` names the key column of the output and describes it. The key is the input's own key, such as the `guid` of a bank text in the rule `BankCharges` of ipay, a host in context-compiler (`apps/ipay/src/rules/bank-charges.ts`).
- **`identity(input)` names what makes the output.** When it changes, the dataset makes the output again ([ADR 0005](../adr/0005-an-output-is-made-again-when-its-rule-identity-changes.md)). Name each thing that makes the output: `Chunking` names its package version, its tokenizer and its sizes (`packages/chunking/src/chunking.ts`). A rule that calls a model names the model, its instructions, the schema and the settings, as `InvoicePayments` of ipay does (`apps/ipay/src/rules/invoice-payments.ts`). `null` means that the rule does not handle the input: an output made before stays, and a missing one is stored `empty` with the rule identity `unsupported`.
- **`batch` and `concurrency` follow the cost of one input.** A rule whose work is synchronous takes many inputs in one call, with `concurrency` 1: `BankCharges` takes 500 and `Chunking` 32. A rule that makes one model call for each input takes `batch` 1 and runs calls side by side: `InvoicePayments`, `Evaluation` of websets and `ProgramOffers` of startup-credits take `concurrency` 4. Each call commits as it settles, so a slow call holds only its own place ([elt-sqlite ADR 0003](../../../destinations/sqlite/docs/adr/0003-each-rule-call-commits-as-it-settles.md)).
- **`compute` gives one output for each input, in the order of the inputs.** An output is `{ value }`, `{ empty: true }`, `{ error }` or `{ gone: true }`. Give `{ gone: true }` when the input was gone before the rule read it, for example when a stop ended the refresh: no row is written. Give `signal` to each call that can wait, such as a model call.
- **A table rule gives `{ parts }` with one or more parts.** A list of no parts does not compile, so an input with no parts is `{ empty: true }`. The part hash covers only the content columns, so a part that only moved keeps its part hash. See [Write a table rule](../../README.md#write-a-table-rule).
- **The kind of a rule column sets the type of its value.** A value that does not fit its column, such as an integer that is not a safe integer, is a rule failure of its input. See [Write a rule](../../README.md#write-a-rule).
- **The `ComputedDataset` of elt-sqlite, elt-postgresql and elt-sqlserver takes a `Rule` or a `TableRule` in `compute`.** For a table rule, the dataset of elt-postgresql makes its own `PostgresPartsTable`, and the dataset of elt-sqlserver its own `SqlServerPartsTable` (`packages/destinations/postgresql/src/computed-dataset.ts`, `packages/destinations/sqlserver/src/computed-dataset.ts`). See [Write a table rule](../../README.md#write-a-table-rule).
