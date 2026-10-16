import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { identifier } from './counterparts.ts';

test('one number or address is one identifier however an app stores it', () => {
  using database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE stored (value TEXT)');
  const insert = database.prepare('INSERT INTO stored VALUES (?)');
  const stored = [
    '+962 79 123-4567',
    '962791234567',
    '+1 (202) 555.0143',
    '079 123 4567',
    '0791234567',
    '988 77',
    '1234567',
    '1234567890123456',
    ' Rana@Example.com ',
    'MAILTO:Dana@Example.com',
    ' ArabBank ',
  ];
  for (const value of stored) insert.run(value);
  const { type, identifier: value } = identifier('value');

  const read = database
    .prepare(
      `SELECT value AS stored, ${type} AS type, ${value} AS identifier FROM stored`,
    )
    .all()
    .map(({ stored, type, identifier }) => [stored, type, identifier]);

  assert.deepEqual(read, [
    ['+962 79 123-4567', 'phone', '+962791234567'],
    // International digits without + gain one.
    ['962791234567', 'phone', '+962791234567'],
    ['+1 (202) 555.0143', 'phone', '+12025550143'],
    // A national number needs its country, so it stays app, as its digits.
    ['079 123 4567', 'app', '0791234567'],
    ['0791234567', 'app', '0791234567'],
    ['988 77', 'app', '98877'],
    ['1234567', 'app', '1234567'],
    ['1234567890123456', 'app', '1234567890123456'],
    [' Rana@Example.com ', 'email', 'rana@example.com'],
    ['MAILTO:Dana@Example.com', 'email', 'dana@example.com'],
    [' ArabBank ', 'app', 'ArabBank'],
  ]);
});
