import assert from 'node:assert/strict';
import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Docker, TestRun } from '@zukhruf/testing/docker';
import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

import { Automations } from './automations.ts';
import { CareemCalories } from './careem-calories.ts';

const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });
const postgresql = new Postgres({ docker });

async function createMailSchema(sql: postgres.Sql): Promise<void> {
  // The marts views the Mail load publishes, with their column types as
  // the live warehouse reports them: ids are text, deleted is a number.
  await sql`CREATE SCHEMA marts`;
  await sql`CREATE TABLE marts.mail_addresses (id text PRIMARY KEY, address text, comment text)`;
  await sql`CREATE TABLE marts.mail_subjects (id text PRIMARY KEY, subject text)`;
  await sql`CREATE TABLE marts.mail_messages (
    id text PRIMARY KEY, sender text, subject text, "subjectPrefix" text,
    "dateSent" timestamptz, "dateReceived" timestamptz,
    deleted double precision DEFAULT 0
  )`;
  await sql`CREATE TABLE marts.mail_message_parts (
    "messageId" text, "partId" text, "parentPartId" text, "contentType" text,
    "isAttachment" boolean, text text, PRIMARY KEY ("messageId", "partId")
  )`;
}

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
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(database.connectionString, { max: 1, onnotice: () => {} }),
    (sql) => sql.end(),
  );
  await createMailSchema(sql);
  await sql`INSERT INTO marts.mail_addresses (id, address) VALUES
    ('1', 'email@transactional.careem.com'), ('2', 'orders@example-food.com')`;
  await sql`INSERT INTO marts.mail_subjects VALUES
    ('1', 'Your Delivery  From Al Hanaa Butchery & Grills'),
    ('2', 'Your Delivery  From Peri Peri 🇯🇴  '),
    ('3', 'Your weekend treat is here'),
    ('4', 'Your payment did not go through'),
    ('5', 'Your Delivery From Somewhere Else')`;
  await sql`INSERT INTO marts.mail_messages (id, sender, subject, "dateReceived", deleted) VALUES
    ('10', '1', '1', '2026-10-09T11:13:22Z', 0),
    ('11', '1', '2', '2026-10-08T11:30:51Z', 0),
    ('12', '1', '3', '2026-10-08T15:00:00Z', 0),
    ('13', '1', '4', '2026-10-07T10:00:00Z', 0),
    ('14', '2', '5', '2026-10-06T10:00:00Z', 0),
    ('15', '1', '1', '2026-10-09T11:13:23Z', 0),
    ('16', '1', '1', '2026-10-05T11:00:00Z', 1)`;
  await sql`INSERT INTO marts.mail_message_parts
    ("messageId", "partId", "parentPartId", "contentType", "isAttachment", text) VALUES
    ('10', '1', NULL, 'multipart/alternative', false, NULL),
    ('10', '1.1', '1', 'text/plain', false, ${plainReceipt}),
    ('10', '1.2', '1', 'text/html', false, ${htmlReceipt}),
    ('11', '1', NULL, 'text/html', false, ${htmlReceipt}),
    ('11', '2', NULL, 'text/plain', true, 'Order ID: 777 from an attached file'),
    ('12', '1', NULL, 'text/plain', false, 'Order ID: 888, 20% off this weekend'),
    ('13', '1', NULL, 'text/plain', false, 'Your payment for Order ID: 999 did not go through'),
    ('14', '1', NULL, 'text/plain', false, 'Order ID: 444'),
    ('15', '1', NULL, 'text/plain', false, ${plainReceipt}),
    ('16', '1', NULL, 'text/plain', false, 'Your total bill: JOD 3.00 Order ID: 100000003')`;

  const matches = await new CareemCalories('/unused').evaluate(sql);

  assert.deepEqual(
    matches.map(({ key }) => key).sort(),
    ['100000001', '100000002'],
    'a promotion, a failed payment, another sender, an attachment, a deleted receipt and a second copy of a receipt add no order',
  );
  const kofta = matches.find(({ key }) => key === '100000001');
  assert.equal(kofta?.data.restaurant, 'Al Hanaa Butchery & Grills');
  assert.equal(kofta?.data.receivedAt, '2026-10-09T11:13:22.000Z');
  assert.equal(kofta?.data.receipt, plainReceipt, 'the text/plain part wins');
  const periPeri = matches.find(({ key }) => key === '100000002');
  assert.equal(periPeri?.data.restaurant, 'Peri Peri 🇯🇴');
  assert.equal(
    periPeri?.data.receipt,
    'Your total bill: JOD 12.90 Delivery details Peri Peri 🇯🇴 7th Circle, Amman Oct 8, 1:55 PM Oct 8, 2:30 PM Order ID: 100000002 1 × Meido Meal JOD 6.99 + thigh & breast JOD 0.00 1 × Peri Ciabatta Sandwich JOD 3.29',
    'an HTML-only receipt reaches the agent as its text',
  );
});

test('a receipt whose body Mail downloads after the baseline makes the agent act once, when the body arrives', async () => {
  await using database = await postgresql.database();
  await using clients = new AsyncDisposableStack();
  const sql = clients.adopt(
    postgres(database.connectionString, { max: 1, onnotice: () => {} }),
    (sql) => sql.end(),
  );
  await createMailSchema(sql);
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'proactive-test-'),
  );
  const shown = join(directory.path, 'shown.jsonl');
  const asked = join(directory.path, 'asked.jsonl');
  await writeFile(shown, '');
  await writeFile(asked, '');
  // macOS shows a notification for real, on the user's screen, and the real
  // Codex service needs an authenticated, paid request. These executables
  // stand in for /usr/bin/osascript and codex and record what they were given.
  const osascript = join(directory.path, 'osascript');
  await writeFile(
    osascript,
    `#!${process.execPath}
import { appendFile } from 'node:fs/promises';
await appendFile(${JSON.stringify(shown)}, JSON.stringify(process.argv.at(-1)) + '\\n');
`,
    { mode: 0o700 },
  );
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
  const lines = async (path: string) =>
    (await readFile(path, 'utf8'))
      .split('\n')
      .filter((line) => line !== '')
      .map((line): unknown => JSON.parse(line));
  // Mail knows the receipt's headers before it downloads its body, so the
  // import has the message without a part.
  await sql`INSERT INTO marts.mail_addresses (id, address) VALUES ('1', 'email@transactional.careem.com')`;
  await sql`INSERT INTO marts.mail_subjects VALUES ('1', 'Your Delivery  From Al Hanaa Butchery & Grills')`;
  await sql`INSERT INTO marts.mail_messages (id, sender, subject, "dateReceived") VALUES
    ('40465', '1', '1', '2026-10-09T11:13:22Z')`;
  const automations = new Automations({
    warehouse: {
      sql,
      async *commits() {
        yield;
      },
    },
    osascript,
  });
  await automations.add(
    new CareemCalories(join(directory.path, 'agent'), codex),
  );

  await sql`INSERT INTO marts.mail_message_parts
    ("messageId", "partId", "parentPartId", "contentType", "isAttachment", text) VALUES
    ('40465', '1', NULL, 'text/plain', false, ${plainReceipt})`;

  assert.equal(await automations.run(new AbortController().signal), 0);
  assert.deepEqual(await lines(asked), ['100000001']);
  assert.deepEqual(await lines(shown), ['Logged order 100000001']);

  assert.equal(await automations.run(new AbortController().signal), 0);
  assert.deepEqual(
    await lines(asked),
    ['100000001'],
    'the order is logged once while its receipt stays',
  );
});
