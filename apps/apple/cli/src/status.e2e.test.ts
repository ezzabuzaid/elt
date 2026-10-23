import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ConnectorStatus } from './imports.ts';

const entry = join(import.meta.dirname, 'main.js');

test('status lists disabled connectors and keeps configuration separate from sync state', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'cli-status-'));
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [entry, ...args], {
      cwd: scratch.path,
      env: { ...process.env, HOME: scratch.path },
      encoding: 'utf8',
      timeout: 10_000,
    });
  const status = (): ConnectorStatus[] => {
    const result = cli('status', '--json');
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  const initial = status();
  assert.ok(initial.some(({ connector }) => connector === 'notes'));
  assert.ok(initial.some(({ connector }) => connector === 'calendar'));
  assert.equal(
    new Set(initial.map(({ connector }) => connector)).size,
    initial.length,
  );
  for (const row of initial) {
    assert.equal(row.enabled, false);
    assert.equal(row.state, null);
    assert.equal(row.selection, null);
    assert.equal(row.database, null);
    assert.equal(row.completedAt, null);
    assert.equal(row.lastSuccessAt, null);
    assert.equal(row.currentAsOf, null);
    assert.equal(row.error, null);
    assert.deepEqual(row.streams, []);
  }

  const setup = cli('setup', '--connector', 'notes', '--no-attachments');
  assert.equal(setup.status, 0, setup.stderr);
  const selected = status();
  assert.equal(selected.length, initial.length);
  assert.deepEqual(
    selected
      .filter(({ enabled }) => enabled)
      .map(({ connector, state }) => ({ connector, state })),
    [{ connector: 'notes', state: 'never' }],
  );
  assert.ok(
    selected
      .filter(({ enabled }) => !enabled)
      .every(({ state }) => state === null),
  );

  const rendered = spawnSync(
    '/usr/bin/expect',
    [
      '-c',
      `spawn -noecho {${process.execPath}} {${entry}} status; expect eof; lassign [wait] pid spawned failed status; exit $status`,
    ],
    {
      cwd: scratch.path,
      env: { ...process.env, HOME: scratch.path },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /Connector\s+Configuration\s+Sync/);
  assert.match(rendered.stdout, /Notes\s+enabled\s+never/);
  assert.match(rendered.stdout, /Calendar\s+disabled\s+—/);

  const replaced = cli('setup', '--connector', 'contacts', '--no-attachments');
  assert.equal(replaced.status, 0, replaced.stderr);
  const changed = status();
  assert.equal(changed.length, initial.length);
  assert.deepEqual(
    changed
      .filter(({ enabled }) => enabled)
      .map(({ connector, state }) => ({ connector, state })),
    [{ connector: 'contacts', state: 'never' }],
  );
  const notes = changed.find(({ connector }) => connector === 'notes');
  assert.equal(notes?.enabled, false);
  assert.equal(notes?.state, null);
});
