import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  OpenAISettingsCapabilitySchema,
  OpenAISettingsReadResultSchema,
  OpenAISettingsUpdateResultSchema,
} from '@openai/mcp-extensions/server';
import { noteStoreFixture } from './fixtures/notes-store.ts';

const root = resolve(import.meta.dirname, '../../..');

// A selected_apps row with its import's latest pass from sync_status, as the
// query-apple skill reads them.
type SelectedApp = {
  app: string;
  scope: string;
  include_attachments: 0 | 1;
  database: string;
  connection_error: string | null;
  sync:
    | {
        status: string;
        error: string | null;
        last_successful_sync_at: string | null;
      }
    | undefined;
};

// The query-apple skill's read command: everything as arguments, since the
// read-only sandbox refuses the temporary file a heredoc needs.
function read(database: string, sql: string, ...commands: string[]) {
  const { stdout, stderr, status } = spawnSync(
    '/usr/bin/sqlite3',
    [
      '-readonly',
      '-json',
      ...['.timeout 30000', 'PRAGMA temp_store = MEMORY', ...commands].flatMap(
        (command) => ['-cmd', command],
      ),
      database,
      sql,
    ],
    { encoding: 'utf8' },
  );
  return { rows: JSON.parse(stdout || '[]'), stderr, status };
}

test('the committed Apple plugin installs from the repo marketplace, sets up through Codex bundled Node, keeps its import current in the background and serves it to the skill read command', {
  timeout: 180_000,
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
  // The user's Notes, where the server looks for them under this HOME.
  const noteStore = await noteStoreFixture(
    join(scratch.path, 'Library/Group Containers/group.com.apple.notes'),
  );
  const retitle = (title: string) => {
    using database = new DatabaseSync(noteStore);
    database
      .prepare(
        "UPDATE ZICCLOUDSYNCINGOBJECT SET ZTITLE1 = ? WHERE ZIDENTIFIER = 'NOTE-RICH'",
      )
      .run(title);
  };
  let diagnostics = '';
  const launch = () => {
    const transport = new StdioClientTransport({
      command: join(plugin, apple.command),
      args: apple.args,
      cwd: join(plugin, apple.cwd),
      env: { HOME: scratch.path, CODEX_MCP_NODE_PATH: runtime, PATH: '' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (data) => {
      diagnostics += String(data);
    });
    return transport;
  };
  const connect = async (client: Client) => {
    const transport = launch();
    await client.connect(transport, { signal: t.signal, timeout: 5_000 });
    return transport;
  };
  const call = (client: Client, name: string, args?: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }, undefined, {
      signal: t.signal,
      timeout: 90_000,
    });
  const invoke = async (
    client: Client,
    name: string,
    args?: Record<string, unknown>,
  ) => {
    const result = await call(client, name, args);
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.ok(Array.isArray(result.content));
    const block = result.content[0];
    assert.equal(block?.type, 'text');
    return JSON.parse(block.text);
  };
  // The skill's entry point: the selection, with no tool call.
  const settingsFile = join(
    scratch.path,
    'Library/Application Support/Context Compiler/Apple/settings.sqlite',
  );
  const selected = (): SelectedApp[] =>
    read(
      settingsFile,
      'SELECT app, scope, include_attachments, database, connection_error FROM selected_apps',
    ).rows.map((app: Omit<SelectedApp, 'sync'>) => ({
      ...app,
      sync: read(
        app.database,
        'SELECT status, error, last_successful_sync_at FROM sync_status',
      ).rows[0],
    }));
  // Waits for the leading server until the selected apps reach the state done
  // looks for.
  const settled = async (
    what: string,
    done: (apps: SelectedApp[]) => boolean,
  ): Promise<SelectedApp[]> => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const apps = selected();
      if (done(apps)) return apps;
      await sleep(500);
    }
    assert.fail(`The import never ${what}`);
  };
  const imported = async (title: string) => {
    const [notes] = await settled(
      `showed ${title}`,
      ([notes]) =>
        notes?.sync?.status === 'succeeded' &&
        read(
          notes.database,
          'SELECT title FROM notes WHERE title = @title',
          `.parameter set @title "'${title}'"`,
        ).rows.length === 1,
    );
    assert.ok(notes);
    return notes;
  };

  const client = new Client(
    { name: 'apple-e2e', version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } } },
  );
  const forms: string[] = [];
  client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
    forms.push(params.message);
    // A person reads the form for longer than the SDK's 60 s request default.
    await sleep(61_000);
    return { action: 'accept', content: { apps: ['notes'] } };
  });
  const other = new Client({ name: 'another-chat', version: '1.0.0' });
  const transport = await connect(client);
  const otherTransport = await connect(other);
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      [
        'apple_configure',
        'apple_options',
        'apple_settings_read',
        'apple_settings_update',
        'apple_setup',
      ],
    );
    // The server names the installed version, which decides who leads.
    assert.equal(client.getServerVersion()?.version, manifest.version);
    // The plugin page's native Settings section names two of those tools.
    assert.deepEqual(
      OpenAISettingsCapabilitySchema.parse(
        client.getServerCapabilities()?.experimental?.['openai/settings'],
      ),
      { readTool: 'apple_settings_read', updateTool: 'apple_settings_update' },
    );
    assert.deepEqual(selected(), []);
    assert.deepEqual((await call(other, 'apple_setup')).content, [
      { type: 'text', text: 'Client does not support form elicitation.' },
    ]);

    // Setup returns once the answers are saved; the import runs apart from it.
    const setUp = await invoke(client, 'apple_setup');
    // One form: the apps. Notes is imported in full without further questions.
    assert.equal(forms.length, 1);
    assert.match(forms[0] ?? '', /Choose the Apple apps/);
    assert.deepEqual(setUp.unavailable, []);
    assert.deepEqual(
      setUp.apps.map(({ app }: { app: string }) => app),
      ['notes'],
    );
    const synced = await imported('Groceries');
    // The file the skill reads tells what it holds and how fresh it is.
    assert.deepEqual(
      read(
        synced.database,
        "SELECT name FROM catalog WHERE kind = 'view' AND name IN ('notes', 'stream_status') ORDER BY name",
      ).rows,
      [{ name: 'notes' }, { name: 'stream_status' }],
    );
    assert.deepEqual(
      read(
        synced.database,
        "SELECT status FROM stream_status WHERE stream = 'notes' AND last_successful_sync_at IS NOT NULL",
      ).rows,
      [{ status: 'succeeded' }],
    );
    assert.deepEqual(
      read(
        synced.database,
        'SELECT id FROM notes WHERE title = @title',
        `.parameter set @title "'Groceries'"`,
      ).rows,
      [{ id: 'NOTE-RICH' }],
    );
    const settings = OpenAISettingsReadResultSchema.parse(
      (await call(client, 'apple_settings_read', {})).structuredContent,
    );
    assert.equal(settings.values.notes, true);
    assert.equal(settings.values.mail, false);
    const notesSetting = settings.schema.properties?.notes as
      | { description?: string }
      | undefined;
    assert.match(
      String(notesSetting?.description),
      /^Synced (just now|\d+ seconds? ago) · everything\.$/,
    );
    const write = read(synced.database, 'DELETE FROM raw_notes;');
    assert.match(write.stderr, /readonly/);
    assert.equal(
      read(
        synced.database,
        "SELECT name FROM catalog WHERE name = 'attachments.attachmentRef'",
      ).rows.length,
      1,
    );
    const [attachment] = read(
      synced.database,
      'SELECT attachmentRef FROM attachments WHERE id = @id',
      `.parameter set @id "'ATT-FILE'"`,
    ).rows;
    assert.equal(
      readFileSync(String(attachment.attachmentRef), 'utf8'),
      'attached words',
    );

    // An app macOS does not allow fails alone, and Notes keeps its import.
    await invoke(client, 'apple_configure', {
      apps: [
        {
          app: 'notes',
          scope: JSON.parse(synced.scope),
          includeAttachments: synced.include_attachments === 1,
        },
        { app: 'messages' },
      ],
    });
    const [kept, messages] = await settled(
      'reported Messages as failed',
      ([notes, messages]) =>
        notes?.sync?.status === 'succeeded' &&
        messages?.sync?.status === 'failed',
    );
    assert.ok(kept && messages?.sync);
    assert.equal(kept.database, synced.database);
    assert.match(String(messages.sync.error), /Full Disk Access/);

    // A change in Notes reaches the import while nobody calls a tool.
    retitle('Groceries (edited)');
    assert.equal(
      (await imported('Groceries (edited)')).database,
      synced.database,
    );
    assert.equal(
      (await call(client, 'apple_options', { app: 'invalid' })).isError,
      true,
    );

    // When the leading chat closes, another chat's server keeps importing.
    await client.close();
    await transport.close();
    retitle('Groceries (after handoff)');
    await imported('Groceries (after handoff)');

    // Switching Notes off on the Settings page disconnects it and deletes
    // its import; Messages stays selected.
    const switched = OpenAISettingsUpdateResultSchema.parse(
      (await call(other, 'apple_settings_update', { set: { notes: false } }))
        .structuredContent,
    );
    assert.equal(switched.values.notes, false);
    assert.equal(switched.values.messages, true);
    assert.equal(existsSync(synced.database), false);
    assert.deepEqual(
      selected().map(({ app }) => app),
      ['messages'],
    );
  } finally {
    await client.close();
    await transport.close();
    await other.close();
    await otherTransport.close();
  }
  assert.ok(!diagnostics.includes('Error'), diagnostics);
});
