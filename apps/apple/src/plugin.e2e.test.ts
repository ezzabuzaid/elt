import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(import.meta.dirname, '../../..');

// The query-apple skill's read command: SQL and dot-commands on stdin.
function read(database: string, script: string) {
  const { stdout, stderr, status } = spawnSync(
    '/usr/bin/sqlite3',
    ['-readonly', '-json', database],
    { input: `.timeout 30000\n${script}`, encoding: 'utf8' },
  );
  return { rows: JSON.parse(stdout || '[]'), stderr, status };
}

test('the committed Apple plugin installs from the repo marketplace, sets up through Codex bundled Node and serves its imports to the skill read command', {
  timeout: 30_000,
}, async (t) => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'apple-e2e-'));
  const marketplace = JSON.parse(
    readFileSync(join(root, '.agents/plugins/marketplace.json'), 'utf8'),
  );
  const [entry] = marketplace.plugins;
  assert.equal(entry.name, 'apple');
  // Codex copies the plugin directory into its cache and runs it from there.
  const plugin = join(scratch.path, 'plugin');
  cpSync(join(root, entry.source.path), plugin, { recursive: true });
  for (const path of readdirSync(plugin, { recursive: true, encoding: 'utf8' }))
    assert.equal(lstatSync(join(plugin, path)).isSymbolicLink(), false, path);
  const manifest = JSON.parse(
    readFileSync(join(plugin, '.codex-plugin/plugin.json'), 'utf8'),
  );
  assert.equal(manifest.name, entry.name);
  for (const path of [
    manifest.extensions['com.openai'].onboardingSkill,
    manifest.interface.logo,
    manifest.interface.composerIcon,
    './skills/query-apple/SKILL.md',
  ])
    assert.ok(existsSync(join(plugin, path)), path);
  const {
    mcpServers: { apple },
  } = JSON.parse(readFileSync(join(plugin, manifest.mcpServers), 'utf8'));
  accessSync(join(plugin, apple.command), constants.X_OK);
  const runtime =
    process.env.CODEX_MCP_NODE_PATH ??
    join(
      homedir(),
      '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node',
    );
  assert.ok(
    existsSync(runtime),
    'Open the ChatGPT desktop app to install the Codex bundled runtime',
  );
  const transport = new StdioClientTransport({
    command: join(plugin, apple.command),
    args: apple.args,
    cwd: join(plugin, apple.cwd),
    env: { HOME: scratch.path, CODEX_MCP_NODE_PATH: runtime, PATH: '' },
    stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr?.on('data', (data) => {
    diagnostics += String(data);
  });
  const client = new Client({ name: 'apple-e2e', version: '1.0.0' });
  const call = (name: string, args?: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }, undefined, {
      signal: t.signal,
      timeout: 10_000,
    });
  const invoke = async (name: string, args?: Record<string, unknown>) => {
    const result = await call(name, args);
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.ok(Array.isArray(result.content));
    const block = result.content[0];
    assert.equal(block?.type, 'text');
    return JSON.parse(block.text);
  };
  try {
    await client.connect(transport, { signal: t.signal, timeout: 5_000 });
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      [
        'apple_configure',
        'apple_options',
        'apple_setup',
        'apple_status',
        'apple_sync',
      ],
    );
    assert.equal((await invoke('apple_status')).configured, false);
    await invoke('apple_configure', { apps: [{ app: 'notes' }] });
    assert.equal((await invoke('apple_status')).apps[0].database, null);
    assert.equal(
      (await call('apple_options', { app: 'invalid' })).isError,
      true,
    );

    // Stand in for a sync of the user's Notes.
    const imported = join(
      scratch.path,
      'Library/Application Support/Context Compiler/Apple/notes',
    );
    mkdirSync(imported, { recursive: true });
    {
      using database = new DatabaseSync(join(imported, 'data.sqlite'));
      database.exec(`CREATE TABLE notes(id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE _apple_catalog(name TEXT PRIMARY KEY, schema_json TEXT, coverage_json TEXT);
        INSERT INTO notes VALUES('n1','It''s selected'),('n2','Other');
        INSERT INTO _apple_catalog VALUES('notes','{}','{}');`);
    }
    const [notes] = (await invoke('apple_status')).apps;
    assert.equal(notes.database, join(imported, 'data.sqlite'));
    assert.deepEqual(
      read(notes.database, 'SELECT name FROM _apple_catalog;').rows,
      [{ name: 'notes' }],
    );
    assert.deepEqual(
      read(
        notes.database,
        `.parameter set @name "'It''s selected'"\nSELECT id FROM notes WHERE name = @name;`,
      ).rows,
      [{ id: 'n1' }],
    );
    const write = read(notes.database, 'DELETE FROM notes;');
    assert.match(write.stderr, /readonly/);
    assert.deepEqual(
      read(notes.database, 'SELECT count(*) AS n FROM notes;').rows,
      [{ n: 2 }],
    );
  } finally {
    await client.close();
    await transport.close();
  }
  assert.ok(!diagnostics.includes('Error'), diagnostics);
});
