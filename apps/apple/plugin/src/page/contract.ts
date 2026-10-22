import { z } from 'zod';

// What the Apple page reads from the plugin's page tools. The server declares
// these as the tools' output schemas, so the SDK checks every result against
// what the page parses.

const scope = z.strictObject({
  accountIds: z.array(z.string()).readonly().optional(),
  collectionIds: z.array(z.string()).readonly().optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
});

const selection = z.strictObject({
  scope,
  includeAttachments: z.boolean(),
});

const row = z.strictObject({
  name: z.string(),
  title: z.string(),
  loaded: z.boolean(),
  selection: selection.nullable(),
  // The user keeps it current: it loads each change while ChatGPT is open.
  watched: z.boolean(),
  status: z.strictObject({
    state: z.enum([
      'off',
      'waiting',
      'running',
      'succeeded',
      'partial',
      'failed',
      'cancelled',
    ]),
    text: z.string(),
    details: z.array(z.string()).readonly(),
    // Granting ChatGPT Full Disk Access is the fix for this failure.
    fullDiskAccess: z.boolean(),
  }),
  narrowsBy: z.strictObject({
    accountIds: z.boolean(),
    collectionIds: z.boolean(),
  }),
  datedBy: z.string().nullable(),
});

export const connectorsResult = { connectors: z.array(row).readonly() };

// A monitor as its row and its page show it: what it watches and does, the
// chat its instruction goes to, and its status line.
const monitorRow = z.strictObject({
  name: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  instruction: z.string().nullable(),
  chat: z.string().nullable(),
  status: z.strictObject({
    state: z.enum(['watching', 'failed', 'inactive']),
    text: z.string(),
  }),
});

export const monitorsResult = { monitors: z.array(monitorRow).readonly() };

export const choicesResult = {
  choices: z
    .array(
      z.strictObject({
        scope: z.enum(['accountIds', 'collectionIds']),
        title: z.string(),
        options: z
          .array(z.strictObject({ id: z.string(), label: z.string() }))
          .readonly(),
      }),
    )
    .readonly(),
  datedBy: z.string().nullable(),
  // What connecting imports when the user narrows nothing.
  defaultSelection: selection,
  note: z.string().optional(),
};

// The Apple page's deep link, and the path in it that opens one connector's
// page. The bare plugin name resolves to the one Apple plugin installed.
export const pageLink = 'codex://plugins/apple/app/apple_page';

const connectorPath = (connector: string) =>
  `/connectors/${encodeURIComponent(connector)}`;

export const connectorLink = (connector: string) =>
  `${pageLink}?path=${encodeURIComponent(connectorPath(connector))}`;

// The connector a deep link's path opens, if it names one.
export function connectorIn(path: string): string | undefined {
  const name = /^\/connectors\/([^/?#]+)/.exec(path)?.[1];
  return name === undefined ? undefined : decodeURIComponent(name);
}

export type ConnectorSelection = z.infer<typeof selection>;
export type ConnectorRow = z.infer<typeof row>;
export type MonitorRow = z.infer<typeof monitorRow>;
export type ConnectorChoices = z.infer<z.ZodObject<typeof choicesResult>>;

// Models by the id Handy installs them under.
export const transcriptionResult = {
  selected: z.string().nullable(),
  models: z.array(z.strictObject({ id: z.string(), title: z.string() })),
};
export type TranscriptionChoices = z.infer<
  z.ZodObject<typeof transcriptionResult>
>;
