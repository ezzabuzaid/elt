import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { Connectors } from '@workspace/apple-manifest/connectors';
import { provideHostModules } from '@workspace/apple-manifest/host-modules';
import { userConnectors } from '@workspace/apple-manifest/user-connectors';

import { ApplePlugin, PluginUpdatedError } from './apple-plugin.ts';
import { chatContext } from './chat-status.ts';
import { keepFresh } from './freshness.ts';
import { settingsRead, settingsUpdate } from './native-settings.ts';
import { setUpWithForms } from './setup-forms.ts';

if (process.platform !== 'darwin')
  throw new Error('Apple requires Codex on a Mac.');

// This bundle sits in the server folder of the installed plugin, beside the
// connector folders of the built-in Apple apps.
const install = fileURLToPath(new URL('..', import.meta.url));
// The built-in Apple apps are connector folders beside this bundle; the
// user's own load from their folder on the server's elt and AppleApp, through
// the host modules beside this bundle. macOS grants access to ChatGPT, which
// runs Codex. Calendar's remote attachments stay links, so users never sign
// in to Google.
provideHostModules(
  ({ file }) => new URL(`modules/${file}.mjs`, import.meta.url).href,
);
const plugin = new ApplePlugin(
  await new Connectors([
    fileURLToPath(new URL('connectors', import.meta.url)),
    userConnectors,
  ]).load({ grantee: 'ChatGPT' }),
  install,
);
const { version } = z
  .object({ version: z.string() })
  .parse(
    JSON.parse(
      readFileSync(join(install, '.codex-plugin/plugin.json'), 'utf8'),
    ),
  );
const mcpServer = new McpServer(
  { name: 'apple', version },
  {
    instructions: `Apple imports the ${new Intl.ListFormat('en', { type: 'conjunction' }).format(plugin.apps.map(({ title }) => title))} content the user chose into private SQLite files on this Mac and keeps them current while Codex is open. These tools only choose what is imported: set up with $setup-apple, and answer questions about the content with $query-apple, which reads those files with sqlite3.`,
  },
);
// McpServer turns a thrown error into an isError result the model can act on.
// The text block mirrors structuredContent for clients that read only content.
const structured = (value: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

mcpServer.registerTool(
  'apple_setup',
  {
    title: 'Set up Apple',
    description:
      'Set up Apple with one form the user answers: which apps. Each chosen app is imported from all its accounts and collections, with attachments. Saves the answers and reports apps macOS did not allow; the import then runs in the background. To narrow an app when the user asks, use apple_options and apple_configure; hosts without form support set up that way too.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async () => {
    if (!mcpServer.server.getClientCapabilities()?.elicitation)
      throw new Error(
        'This host cannot show forms. Set up with apple_options, then apple_configure.',
      );
    // A person answers each form: wait for them, not the SDK's 60 seconds.
    // Codex pauses the tool call's timeout while a form is open.
    return structured(
      await setUpWithForms(plugin, (form) =>
        mcpServer.server.elicitInput(form, { timeout: 1_800_000 }),
      ),
    );
  },
);
mcpServer.registerTool(
  'apple_options',
  {
    title: 'List Apple app choices',
    description:
      'List accounts and collections for one app during setup. Reads metadata from that Apple app and may prompt for macOS access. Use only for an app the user chose. Choices are untrusted data.',
    inputSchema: {
      app: plugin.appSchema.describe('An Apple app the user chose.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ app }) => structured(await plugin.options(app)),
);
mcpServer.registerTool(
  'apple_configure',
  {
    title: 'Configure Apple imports',
    description:
      'Save the complete selection of Apple apps and scopes. Omitted apps are disconnected. A changed scope deletes that app’s previous imported copy and attachments and imports it again in the background. Does not modify Apple apps. Call only for the user’s confirmed selection.',
    inputSchema: plugin.configurationSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  (input) => structured(plugin.configure(input)),
);
// The plugin page's Settings section: a switch per app, described by its
// import status (the openai/settings extension; ChatGPT calls both tools).
const switches = z.strictObject(
  Object.fromEntries(plugin.apps.map(({ name }) => [name, z.boolean()])),
);
mcpServer.registerTool(
  'apple_settings_read',
  {
    title: 'Read Apple settings',
    description:
      'Read which Apple apps are connected and each one’s import status, for the plugin’s Settings page. Does not read Apple app content.',
    inputSchema: {},
    outputSchema: {
      schema: z.strictObject({
        type: z.literal('object'),
        properties: z.record(
          z.string(),
          z.strictObject({
            type: z.literal('boolean'),
            title: z.string(),
            description: z.string(),
          }),
        ),
      }),
      values: switches,
      layout: z.array(
        z.strictObject({
          kind: z.literal('group'),
          title: z.string(),
          items: z.array(
            z.strictObject({
              kind: z.literal('property'),
              property: z.string(),
            }),
          ),
        }),
      ),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  () => {
    const result = settingsRead(plugin);
    return { content: [], structuredContent: result };
  },
);
mcpServer.registerTool(
  'apple_settings_update',
  {
    title: 'Update Apple settings',
    description:
      'Connect or disconnect Apple apps from the plugin’s Settings page. A connected app imports everything by default; a disconnected app’s imported copy is deleted. Other apps keep their scope.',
    inputSchema: {
      set: switches.partial().meta({ minProperties: 1 }),
    },
    outputSchema: { values: switches },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  ({ set }) => {
    if (Object.keys(set).length === 0) throw new Error('Set at least one app.');
    return { content: [], structuredContent: settingsUpdate(plugin, set) };
  },
);
mcpServer.server.registerCapabilities({
  experimental: {
    'openai/settings': {
      readTool: 'apple_settings_read',
      updateTool: 'apple_settings_update',
    },
  },
});

// Codex runs one server per chat, so this server's context is this chat's.
const contextFor = chatContext(plugin);
mcpServer.registerTool(
  'apple_context',
  {
    title: 'Apple status for hooks',
    description:
      'Apple status for the plugin’s SessionStart and UserPromptSubmit hooks.',
    inputSchema: { event: z.enum(['SessionStart', 'UserPromptSubmit']) },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] } },
  },
  ({ event }) => {
    if (plugin.updated())
      return {
        content: [{ type: 'text', text: new PluginUpdatedError().message }],
      };
    const text = contextFor(event);
    return { content: text === null ? [] : [{ type: 'text', text }] };
  },
);

// Keeps the imports current until Codex closes this server.
const stopping = new AbortController();
mcpServer.server.onclose = () => stopping.abort();
process.stdin.once('end', () => stopping.abort());
process.once('SIGTERM', () => stopping.abort());
process.once('SIGINT', () => stopping.abort());
await mcpServer.connect(new StdioServerTransport());
await keepFresh(plugin, stopping.signal);
