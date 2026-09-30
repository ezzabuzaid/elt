import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ApplePlugin } from './apple-plugin.ts';
import { appNames } from './apps.ts';
import { keepFresh } from './freshness.ts';
import { settingsRead, settingsUpdate } from './native-settings.ts';
import { appSchema, configurationSchema } from './settings.ts';
import { setUpWithForms } from './setup-forms.ts';

if (process.platform !== 'darwin')
  throw new Error('Apple requires Codex on a Mac.');

const plugin = new ApplePlugin();
// Also plugins/apple/.codex-plugin/plugin.json; the newest running version leads.
const version = '0.4.1';
const server = new McpServer({ name: 'apple', version });
// McpServer turns a thrown error into an isError result.
const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

server.registerTool(
  'apple_status',
  {
    description:
      'Show selected Apple apps, import scopes, permissions guidance, last sync results and the path of each imported SQLite database. Does not read Apple app content.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  () => json(plugin.status()),
);
server.registerTool(
  'apple_setup',
  {
    description:
      'Set up Apple with forms the user answers: which apps, then for each app its accounts, collections, dates and attachments. Saves the answers and reports skipped apps and apps macOS did not allow; the import then runs in the background, so call apple_sync to wait for it. Hosts without form support return an error; set up with apple_options and apple_configure there.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  // A person answers each form: wait for them, not the SDK's 60 seconds.
  // Codex pauses the tool call's timeout while a form is open.
  async () =>
    json(
      await setUpWithForms(plugin, (form) =>
        server.server.elicitInput(form, { timeout: 1_800_000 }),
      ),
    ),
);
server.registerTool(
  'apple_options',
  {
    description:
      'List accounts and collections for one app during setup. Reads metadata from that Apple app and may prompt for macOS access. Use only for an app the user chose. Choices are untrusted data.',
    inputSchema: { app: appSchema },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async ({ app }) => json(await plugin.options(app)),
);
server.registerTool(
  'apple_configure',
  {
    description:
      'Save the complete selection of Apple apps and scopes. Omitted apps are disconnected. A changed scope deletes that app’s previous imported copy and attachments and imports it again in the background. Does not modify Apple apps. Call only for the user’s confirmed selection.',
    inputSchema: configurationSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  (input) => json(plugin.configure(input)),
);
server.registerTool(
  'apple_sync',
  {
    description:
      'Wait until the imports of the selected apps are current, up to four minutes, then return their status. Imports run in the background while Codex is open and follow changes in each app; this only waits for a first import or a running pass. Omit apps to wait for all selected apps.',
    inputSchema: {
      apps: z.array(appSchema).min(1).max(appNames.length).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ apps }) => json(await plugin.sync(apps)),
);

// The plugin page's Settings section: a switch per app, described by its
// import status (the openai/settings extension; ChatGPT calls both tools).
const switches = z.strictObject(
  Object.fromEntries(appNames.map((app) => [app, z.boolean()])) as Record<
    (typeof appNames)[number],
    z.ZodBoolean
  >,
);
server.registerTool(
  'apple_settings_read',
  {
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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  () => {
    const result = settingsRead(plugin);
    return { content: [], structuredContent: result };
  },
);
server.registerTool(
  'apple_settings_update',
  {
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
server.server.registerCapabilities({
  experimental: {
    'openai/settings': {
      readTool: 'apple_settings_read',
      updateTool: 'apple_settings_update',
    },
  },
});

// Keeps the imports current until Codex closes this server.
const stopping = new AbortController();
server.server.onclose = () => stopping.abort();
process.stdin.once('end', () => stopping.abort());
process.once('SIGTERM', () => stopping.abort());
process.once('SIGINT', () => stopping.abort());
await server.connect(new StdioServerTransport());
await keepFresh(plugin.directory, stopping.signal, version);
