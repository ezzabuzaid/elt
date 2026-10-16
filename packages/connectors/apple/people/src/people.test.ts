import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { peopleConnectors, peopleFile } from './people.ts';

type Counterpart = {
  relation: string;
  identifier_type: string;
  identifier: string;
  linked_type?: string;
  linked_identifier?: string;
  name?: string;
  first_at?: string;
  last_at?: string;
  occurrences?: number;
  context?: string;
};

type Connector = (typeof peopleConnectors)[number];

// The model reads each import's counterparts and nothing else of it, so each
// import here holds only its counterparts rows. Each connector's own tests
// prove its import publishes counterparts in this shape from its app.
async function people(
  rows: Partial<Record<Connector, readonly Counterpart[]>>,
): Promise<AsyncDisposable & { read(sql: string): Record<string, unknown>[] }> {
  const scratch = await mkdtempDisposable(join(tmpdir(), 'people-'));
  const imports = peopleConnectors.map((connector) => {
    const path = join(scratch.path, `${connector}.sqlite`);
    using database = new DatabaseSync(path);
    database.exec(
      'CREATE TABLE counterparts (relation, identifier_type, identifier, linked_type, linked_identifier, name, first_at, last_at, occurrences, context)',
    );
    const insert = database.prepare(
      'INSERT INTO counterparts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const row of rows[connector] ?? [])
      insert.run(
        row.relation,
        row.identifier_type,
        row.identifier,
        row.linked_type ?? null,
        row.linked_identifier ?? null,
        row.name ?? null,
        row.first_at ?? null,
        row.last_at ?? null,
        row.occurrences ?? 1,
        row.context ?? null,
      );
    return { connector, path };
  });
  return {
    [Symbol.asyncDispose]: () => scratch[Symbol.asyncDispose](),
    // As an agent reads it: the macOS sqlite3 shell, read-only, each import
    // attached under its connector's name, then the model loaded.
    read(sql) {
      const result = spawnSync(
        '/usr/bin/sqlite3',
        [
          '-readonly',
          '-json',
          ...imports.flatMap(({ connector, path }) => [
            '-cmd',
            `ATTACH '${path}' AS "${connector}"`,
          ]),
          '-cmd',
          `.read '${peopleFile}'`,
          ':memory:',
          sql,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.stderr, '');
      assert.equal(result.status, 0);
      return JSON.parse(result.stdout || '[]');
    },
  };
}

const card = (id: string, name: string, linked?: [string, string]) => ({
  relation: 'card',
  identifier_type: 'app',
  identifier: id,
  name,
  ...(linked === undefined
    ? {}
    : { linked_type: linked[0], linked_identifier: linked[1] }),
});

test('a WhatsApp LID chat, a missed call and an SMS from one number all reach the card that holds the number', async () => {
  await using model = await people({
    contacts: [card('RANA:ABPerson', 'Rana', ['phone', '+962791234567'])],
    whatsapp: [
      {
        relation: 'sent',
        identifier_type: 'app',
        identifier: '201812345@lid',
        linked_type: 'phone',
        linked_identifier: '+962791234567',
        name: 'Rana WA',
        first_at: '2024-01-02T10:00:00.000Z',
        last_at: '2026-10-01T09:00:00.000Z',
        occurrences: 40,
      },
    ],
    'call-history': [
      {
        relation: 'missed-call',
        identifier_type: 'phone',
        identifier: '+962791234567',
        first_at: '2025-03-01T08:00:00.000Z',
        last_at: '2025-03-01T08:00:00.000Z',
      },
    ],
    messages: [
      {
        relation: 'received',
        identifier_type: 'phone',
        identifier: '+962791234567',
        first_at: '2019-05-05T05:05:05.000Z',
        last_at: '2020-01-01T00:00:00.000Z',
        occurrences: 3,
      },
    ],
  });

  assert.deepEqual(model.read('SELECT * FROM people'), [
    {
      id: 'RANA:ABPerson',
      name: 'Rana',
      card_id: 'RANA:ABPerson',
      is_self: 0,
      tags: '["call-history:missed-call","contacts:card","messages:received","whatsapp:sent"]',
      first_at: '2019-05-05T05:05:05.000Z',
      last_at: '2026-10-01T09:00:00.000Z',
    },
  ]);
  assert.deepEqual(
    model.read(
      "SELECT type, value, connector FROM person_identifiers WHERE person_id = 'RANA:ABPerson' ORDER BY connector, type",
    ),
    [
      { type: 'phone', value: '+962791234567', connector: 'call-history' },
      { type: 'app', value: 'RANA:ABPerson', connector: 'contacts' },
      { type: 'phone', value: '+962791234567', connector: 'contacts' },
      { type: 'phone', value: '+962791234567', connector: 'messages' },
      { type: 'app', value: '201812345@lid', connector: 'whatsapp' },
      { type: 'phone', value: '+962791234567', connector: 'whatsapp' },
    ],
  );
});

test('two cards that share a number stay two people, each with the call to that number and tagged shared', async () => {
  await using model = await people({
    contacts: [
      card('MOM:ABPerson', 'Mom', ['phone', '+96265000000']),
      card('DAD:ABPerson', 'Dad', ['phone', '+96265000000']),
      card('DAD:ABPerson', 'Dad', ['phone', '+962790000002']),
    ],
    'call-history': [
      {
        relation: 'answered-call',
        identifier_type: 'phone',
        identifier: '+96265000000',
        first_at: '2025-06-01T12:00:00.000Z',
        last_at: '2025-06-01T12:00:00.000Z',
      },
    ],
  });

  assert.deepEqual(
    model.read('SELECT id, name, tags FROM people ORDER BY id'),
    [
      {
        id: 'DAD:ABPerson',
        name: 'Dad',
        tags: '["call-history:answered-call","contacts:card","shared"]',
      },
      {
        id: 'MOM:ABPerson',
        name: 'Mom',
        tags: '["call-history:answered-call","contacts:card","shared"]',
      },
    ],
  );
  // Only the relations matched by the shared number are shared.
  assert.deepEqual(
    model.read(
      "SELECT linked_identifier, shared FROM person_relations WHERE person_id = 'DAD:ABPerson' AND connector = 'contacts' ORDER BY linked_identifier",
    ),
    [
      { linked_identifier: '+96265000000', shared: 1 },
      { linked_identifier: '+962790000002', shared: 0 },
    ],
  );
});

test('someone with no card is one person per identifier, named first by the app that ranks highest', async () => {
  await using model = await people({
    mail: [
      {
        relation: 'sent',
        identifier_type: 'email',
        identifier: 'dana@example.com',
        name: 'D.',
        last_at: '2026-02-01T00:00:00.000Z',
      },
      {
        relation: 'received',
        identifier_type: 'email',
        identifier: 'news@example.com',
        name: 'Example News',
        last_at: '2026-03-01T00:00:00.000Z',
        occurrences: 120,
      },
    ],
    slack: [
      {
        relation: 'received',
        identifier_type: 'app',
        identifier: 'T1:U1',
        linked_type: 'email',
        linked_identifier: 'dana@example.com',
        name: 'Dana Haddad',
        last_at: '2025-12-01T00:00:00.000Z',
      },
    ],
    messages: [
      {
        relation: 'received',
        identifier_type: 'app',
        identifier: '98877',
        last_at: '2026-01-01T00:00:00.000Z',
      },
    ],
  });

  assert.deepEqual(
    model.read('SELECT id, name, card_id, tags FROM people ORDER BY id'),
    [
      { id: '98877', name: null, card_id: null, tags: '["messages:received"]' },
      {
        id: 'dana@example.com',
        name: 'Dana Haddad',
        card_id: null,
        tags: '["mail:sent","slack:received"]',
      },
      {
        id: 'news@example.com',
        name: 'Example News',
        card_id: null,
        tags: '["mail:received"]',
      },
    ],
  );
});

test("the user's own identifiers mark their card, or the identifier itself when no card holds it, as self", async () => {
  await using model = await people({
    contacts: [
      card('ME:ABPerson', 'Ezz', ['email', 'ezz@example.com']),
      {
        ...card('ME:ABPerson', 'Ezz', ['email', 'ezz@example.com']),
        relation: 'self',
      },
    ],
    mail: [
      {
        relation: 'self',
        identifier_type: 'email',
        identifier: 'ezz@example.com',
      },
      {
        relation: 'self',
        identifier_type: 'email',
        identifier: 'ezz@work.example',
      },
    ],
  });

  assert.deepEqual(
    model.read('SELECT id, card_id, is_self, tags FROM people ORDER BY id'),
    [
      {
        id: 'ME:ABPerson',
        card_id: 'ME:ABPerson',
        is_self: 1,
        tags: '["contacts:card","contacts:self","mail:self"]',
      },
      {
        id: 'ezz@work.example',
        card_id: null,
        is_self: 1,
        tags: '["mail:self"]',
      },
    ],
  );
});

test('the model documents every view and column it creates', async () => {
  await using model = await people({});
  const documented = new Set(
    [...readFileSync(peopleFile, 'utf8').matchAll(/^-- (\w+\.\w+): /gm)].map(
      ([line]) => line.slice('-- '.length, -': '.length),
    ),
  );

  const columns = model
    .read(
      `SELECT v.name || '.' || c.name AS name FROM temp.sqlite_schema v, pragma_table_info(v.name, 'temp') c
       WHERE v.type = 'view' AND v.name <> 'all_counterparts'`,
    )
    .map(({ name }) => String(name));

  assert.deepEqual(
    columns.filter((name) => !documented.has(name)),
    [],
  );
  assert.deepEqual(
    [...documented].filter(
      (name) =>
        !name.startsWith('all_counterparts.') && !columns.includes(name),
    ),
    [],
  );
});

test("every app's times read in one form, to the millisecond, and a date an app records without a time stays a date", async () => {
  await using model = await people({
    'call-history': [
      {
        relation: 'outgoing-call',
        identifier_type: 'phone',
        identifier: '+962791234567',
        first_at: '2025-03-01T08:00:00.123456Z',
        last_at: '2025-03-01T08:00:00.123456Z',
      },
    ],
    teams: [
      {
        relation: 'sent',
        identifier_type: 'app',
        identifier: '8:orgid:1',
        linked_type: 'phone',
        linked_identifier: '+962791234567',
        first_at: '2025-03-01T08:00:00.1229999Z',
        last_at: '2026-09-25T08:30:00.1234567Z',
      },
    ],
    calendar: [
      {
        relation: 'attendee',
        identifier_type: 'app',
        identifier: 'room-1',
        first_at: '2026-12-24',
        last_at: '2026-12-24',
      },
    ],
  });

  assert.deepEqual(
    model.read('SELECT id, first_at, last_at FROM people ORDER BY id'),
    [
      {
        id: '+962791234567',
        first_at: '2025-03-01T08:00:00.123Z',
        last_at: '2026-09-25T08:30:00.123Z',
      },
      { id: 'room-1', first_at: '2026-12-24', last_at: '2026-12-24' },
    ],
  );
});
