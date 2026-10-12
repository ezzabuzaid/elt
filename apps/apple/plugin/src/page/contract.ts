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

export type ConnectorSelection = z.infer<typeof selection>;
export type ConnectorRow = z.infer<typeof row>;
export type ConnectorChoices = z.infer<z.ZodObject<typeof choicesResult>>;
