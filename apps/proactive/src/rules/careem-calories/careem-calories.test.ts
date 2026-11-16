import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { Postgres } from '@zukhruf/testing/postgres';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  type CopyConfiguration,
  Gauge,
  Pipeline,
  Source,
  Stream,
} from '@eltjs/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@eltjs/elt-postgresql';

import type { Automation } from '../../engine/automation.ts';
import { CareemCalories } from './careem-calories.ts';

const postgresql = new Postgres({ environment: process.env });

// The marts views the Mail load publishes, with their column types as the
// live warehouse reports them: ids are text, deleted is a number.
const addresses = new Stream({
  name: 'mail_addresses',
  jsonSchema: {
    type: 'object',
    description: 'An address.',
    properties: {
      id: { type: 'string', description: 'Its id.' },
      address: { type: 'string', description: 'The address.' },
      comment: { type: ['string', 'null'], description: 'Its name.' },
    },
    required: ['id', 'address', 'comment'],
  },
  primaryKey: ['id'],
  supportedSyncModes: ['full_refresh'],
});

const subjects = new Stream({
  name: 'mail_subjects',
  jsonSchema: {
    type: 'object',
    description: 'A subject.',
    properties: {
      id: { type: 'string', description: 'Its id.' },
      subject: { type: 'string', description: 'The subject.' },
    },
    required: ['id', 'subject'],
  },
  primaryKey: ['id'],
  supportedSyncModes: ['full_refresh'],
});

const messages = new Stream({
  name: 'mail_messages',
  jsonSchema: {
    type: 'object',
    description: 'A message.',
    properties: {
      id: { type: 'string', description: 'Its id.' },
      sender: { type: 'string', description: 'The id of its sender.' },
      subject: { type: 'string', description: 'The id of its subject.' },
      subjectPrefix: {
        type: ['string', 'null'],
        description: 'The prefix of its subject.',
      },
      dateSent: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'When it was sent.',
      },
      dateReceived: {
        type: 'string',
        format: 'date-time',
        description: 'When it was received.',
      },
      deleted: { type: 'number', description: 'Whether it is deleted.' },
    },
    required: [
      'id',
      'sender',
      'subject',
      'subjectPrefix',
      'dateSent',
      'dateReceived',
      'deleted',
    ],
  },
  primaryKey: ['id'],
  supportedSyncModes: ['full_refresh'],
});

const parts = new Stream({
  name: 'mail_message_parts',
  jsonSchema: {
    type: 'object',
    description: 'A part of a message.',
    properties: {
      messageId: { type: 'string', description: 'The id of its message.' },
      partId: { type: 'string', description: 'Its id in the message.' },
      parentPartId: {
        type: ['string', 'null'],
        description: 'The id of the part that holds it.',
      },
      contentType: { type: 'string', description: 'Its MIME type.' },
      isAttachment: {
        type: 'boolean',
        description: 'Whether it is an attachment.',
      },
      text: { type: ['string', 'null'], description: 'Its text.' },
    },
    required: [
      'messageId',
      'partId',
      'parentPartId',
      'contentType',
      'isAttachment',
      'text',
    ],
  },
  primaryKey: ['messageId', 'partId'],
  supportedSyncModes: ['full_refresh'],
});

type Address = { id: string; address: string; comment: string | null };
type Subject = { id: string; subject: string };
type Message = {
  id: string;
  sender: string;
  subject: string;
  subjectPrefix: string | null;
  dateSent: string | null;
  dateReceived: string;
  deleted: number;
};
type Part = {
  messageId: string;
  partId: string;
  parentPartId: string | null;
  contentType: string;
  isAttachment: boolean;
  text: string | null;
};
type Mailbox = {
  addresses: Address[];
  subjects: Subject[];
  messages: Message[];
  parts: Part[];
};

// The upstream of the test source, which the test fills before it reads.
class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// Reads every row Mail holds so far, as an upstream that replaces its tables
// whole.
class Received extends Source {
  readonly identity = 'received';
  protected readonly catalog = new Catalog([
    addresses,
    subjects,
    messages,
    parts,
  ]);
  readonly #mailbox: Mailbox;

  constructor(mailbox: Mailbox) {
    super();
    this.#mailbox = mailbox;
  }

  override coverage() {
    return { description: 'test', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  override changeSignals(streams: readonly Stream[]): ChangeSignal[] {
    return [{ gauge: new Filled(), streams, interval: 1000, timeout: 1000 }];
  }

  protected override async *extract({ stream }: CopyConfiguration) {
    for (const data of this.#rows(stream)) yield { stream: stream.name, data };
  }

  #rows(stream: Stream): readonly object[] {
    switch (stream) {
      case addresses:
        return this.#mailbox.addresses;
      case subjects:
        return this.#mailbox.subjects;
      case messages:
        return this.#mailbox.messages;
      case parts:
        return this.#mailbox.parts;
      default:
        throw new TypeError(`Mail has no stream ${stream.name}`);
    }
  }
}

// The Mail import in a warehouse: each load gives the marts views every row
// Mail holds so far, and a rule reads them as of two loads.
function mail(url: string) {
  const destination = new PostgresDestination({ url, schema: 'raw' });
  const checkpoints = new PostgresCheckpointStore({ url, schema: 'raw' });
  const history = new PostgresSyncHistory({ url });
  const steps = [addresses, subjects, messages, parts].map(
    (stream) =>
      new Copy(
        stream,
        destination.table(stream.name).withReaderView('marts', stream.name),
        {
          id: stream.name,
          syncMode: 'full_refresh',
          destinationSyncMode: 'overwrite',
        },
      ),
  );
  const mailbox: Mailbox = {
    addresses: [],
    subjects: [],
    messages: [],
    parts: [],
  };
  return {
    mailbox,
    async load(): Promise<string> {
      await new Pipeline({
        clock: globalThis,
        history,
        connections: [
          new Connection({
            name: 'mail',
            source: new Received(mailbox),
            destination,
            checkpoints,
            steps,
          }),
        ],
      }).run();
      const positions = await destination.positions();
      if ('expired' in positions) assert.fail(positions.expired);
      const position = positions.at(-1);
      assert.ok(position !== undefined, 'the load made a position');
      return position;
    },
    // What the rule gives between the warehouse as of two positions.
    async evaluate<Data>(
      rule: Automation<Data>,
      from: string,
      to: string,
    ): Promise<readonly Data[]> {
      const before = await destination.reading(from);
      if ('expired' in before) assert.fail(before.expired);
      await using _before = before;
      const after = await destination.reading(to);
      if ('expired' in after) assert.fail(after.expired);
      await using _after = after;
      return await rule.evaluate(before, after);
    },
  };
}

// Rows as the Mail load writes them, a date as Date#toISOString writes it.
// The rule does not read the other columns, so they are NULL.
const address = (id: string, address: string): Address => ({
  id,
  address,
  comment: null,
});
const subject = (id: string, subject: string): Subject => ({ id, subject });
const message = (
  id: string,
  sender: string,
  subject: string,
  dateReceived: string,
  deleted: number,
): Message => ({
  id,
  sender,
  subject,
  subjectPrefix: null,
  dateSent: null,
  dateReceived: new Date(dateReceived).toISOString(),
  deleted,
});
const part = (
  messageId: string,
  partId: string,
  parentPartId: string | null,
  contentType: string,
  isAttachment: boolean,
  text: string | null,
): Part => ({
  messageId,
  partId,
  parentPartId,
  contentType,
  isAttachment,
  text,
});

// A Careem receipt as Mail keeps it, with the numbers changed. Receipts before
// July 2026 also carry this text/plain part; later ones are HTML only.
const plainReceipt = `Your total bill: JOD 9.40
9 October, 2:13 PM

Hi Ezzabuzaid,
Thanks for ordering with us

Delivery details

Al Hanaa Butchery & Grills Al Kabra Complex   amman     Work   33 Mecca street Amman
Oct 9, 1:39 PM    Oct 9, 2:13 PM

Your total bill
JOD 9.40

Order ID: 100000001

1 × Tahini Kofta Tray
JOD 0.00
+ 250 Grams
JOD 6.50
1 × Regular Meat Shawarma Sandwich
JOD 2.00

Order total (incl. tax)
JOD 9.40`;

const htmlReceipt = `<html><head><style>.bill { color: #222; }</style></head><body>
<table><tr><td class="bill">Your total bill: JOD 12.90</td></tr>
<tr><td>Delivery details</td></tr>
<tr><td>Peri Peri 🇯🇴 7th Circle, Amman</td><td>Oct 8, 1:55 PM</td><td>Oct 8, 2:30 PM</td></tr>
<tr><td>Order ID: <b>100000002</b></td></tr>
<tr><td>1 &times; Meido Meal</td><td>JOD 6.99</td></tr>
<tr><td>+ thigh &amp; breast</td><td>JOD 0.00</td></tr>
<tr><td>1 &times; Peri Ciabatta Sandwich</td><td>JOD 3.29</td></tr>
<tr><td>&nbsp;</td></tr></table></body></html>`;

test('each Careem delivery receipt in Mail matches once by its order ID, with the restaurant and the dishes for the agent', async () => {
  await using database = await postgresql.database();
  const warehouse = mail(database.connectionString);
  const empty = await warehouse.load();
  warehouse.mailbox.addresses.push(
    address('1', 'email@transactional.careem.com'),
    address('2', 'orders@example-food.com'),
  );
  warehouse.mailbox.subjects.push(
    subject('1', 'Your Delivery  From Al Hanaa Butchery & Grills'),
    subject('2', 'Your Delivery  From Peri Peri 🇯🇴  '),
    subject('3', 'Your weekend treat is here'),
    subject('4', 'Your payment did not go through'),
    subject('5', 'Your Delivery From Somewhere Else'),
  );
  warehouse.mailbox.messages.push(
    message('10', '1', '1', '2026-10-09T11:13:22Z', 0),
    message('11', '1', '2', '2026-10-08T11:30:51Z', 0),
    message('12', '1', '3', '2026-10-08T15:00:00Z', 0),
    message('13', '1', '4', '2026-10-07T10:00:00Z', 0),
    message('14', '2', '5', '2026-10-06T10:00:00Z', 0),
    message('15', '1', '1', '2026-10-09T11:13:23Z', 0),
    message('16', '1', '1', '2026-10-05T11:00:00Z', 1),
  );
  warehouse.mailbox.parts.push(
    part('10', '1', null, 'multipart/alternative', false, null),
    part('10', '1.1', '1', 'text/plain', false, plainReceipt),
    part('10', '1.2', '1', 'text/html', false, htmlReceipt),
    part('11', '1', null, 'text/html', false, htmlReceipt),
    part(
      '11',
      '2',
      null,
      'text/plain',
      true,
      'Order ID: 777 from an attached file',
    ),
    part(
      '12',
      '1',
      null,
      'text/plain',
      false,
      'Order ID: 888, 20% off this weekend',
    ),
    part(
      '13',
      '1',
      null,
      'text/plain',
      false,
      'Your payment for Order ID: 999 did not go through',
    ),
    part('14', '1', null, 'text/plain', false, 'Order ID: 444'),
    part('15', '1', null, 'text/plain', false, plainReceipt),
    part(
      '16',
      '1',
      null,
      'text/plain',
      false,
      'Your total bill: JOD 3.00 Order ID: 100000003',
    ),
  );
  const received = await warehouse.load();

  const orders = await warehouse.evaluate(
    new CareemCalories('/unused'),
    empty,
    received,
  );

  assert.deepEqual(
    orders.map(({ orderId }) => orderId).sort(),
    ['100000001', '100000002'],
    'a promotion, a failed payment, another sender, an attachment, a deleted receipt and a second copy of a receipt add no order',
  );
  const kofta = orders.find(({ orderId }) => orderId === '100000001');
  assert.equal(kofta?.restaurant, 'Al Hanaa Butchery & Grills');
  assert.equal(kofta?.receivedAt, '2026-10-09T11:13:22.000Z');
  assert.equal(kofta?.receipt, plainReceipt, 'the text/plain part wins');
  const periPeri = orders.find(({ orderId }) => orderId === '100000002');
  assert.equal(periPeri?.restaurant, 'Peri Peri 🇯🇴');
  assert.equal(
    periPeri?.receipt,
    'Your total bill: JOD 12.90 Delivery details Peri Peri 🇯🇴 7th Circle, Amman Oct 8, 1:55 PM Oct 8, 2:30 PM Order ID: 100000002 1 × Meido Meal JOD 6.99 + thigh & breast JOD 0.00 1 × Peri Ciabatta Sandwich JOD 3.29',
    'an HTML-only receipt reaches the agent as its text',
  );
});

test('a receipt whose body Mail downloads after the baseline makes the agent act once, when the body arrives', async () => {
  await using database = await postgresql.database();
  const warehouse = mail(database.connectionString);
  await using directory = await new TemporaryFiles().directory(
    'proactive-test-',
  );
  const asked = join(directory.path, 'asked.jsonl');
  await writeFile(asked, '');
  // The real Codex service needs an authenticated, paid request. This
  // executable stands in for codex and records the order it was given.
  const codex = join(directory.path, 'codex');
  await writeFile(
    codex,
    `#!${process.execPath}
import { appendFile, writeFile } from 'node:fs/promises';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const order = /"orderId":"(\\d+)"/.exec(prompt)[1];
await appendFile(${JSON.stringify(asked)}, JSON.stringify(order) + '\\n');
await writeFile(process.argv[process.argv.indexOf('--output-last-message') + 1], 'Logged order ' + order);
`,
    { mode: 0o700 },
  );
  const asks = async () =>
    (await readFile(asked, 'utf8'))
      .split('\n')
      .filter((line) => line !== '')
      .map((line): unknown => JSON.parse(line));
  // Mail knows the receipt's headers before it downloads its body, so the
  // import has the message without a part.
  warehouse.mailbox.addresses.push(
    address('1', 'email@transactional.careem.com'),
  );
  warehouse.mailbox.subjects.push(
    subject('1', 'Your Delivery  From Al Hanaa Butchery & Grills'),
  );
  warehouse.mailbox.messages.push(
    message('40465', '1', '1', '2026-10-09T11:13:22Z', 0),
  );
  const baseline = await warehouse.load();
  const automation = new CareemCalories(join(directory.path, 'agent'), codex);
  const signal = new AbortController().signal;

  warehouse.mailbox.parts.push(
    part('40465', '1', null, 'text/plain', false, plainReceipt),
  );
  const downloaded = await warehouse.load();
  const again = await warehouse.load();

  const told = await warehouse.evaluate(automation, baseline, downloaded);
  assert.deepEqual(
    told.map(({ orderId }) => orderId),
    ['100000001'],
  );
  assert.deepEqual(
    await Promise.all(told.map((order) => automation.act(order, signal))),
    ['Logged order 100000001'],
  );
  assert.deepEqual(await asks(), ['100000001']);
  assert.deepEqual(
    await warehouse.evaluate(automation, downloaded, again),
    [],
    'the order is told once while its receipt stays',
  );
});
