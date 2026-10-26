import { z } from 'zod';

const text = z.string().nullable();
const count = z.object({ count: z.number(), deleted: z.number() });

export const settingsSchema = z.object({
  inputs: z.array(z.url({ protocol: /^https?$/ })),
  include: z.array(
    z.string().refine(isPattern, { error: 'Not a URL pattern' }),
  ),
});
export type Settings = z.infer<typeof settingsSchema>;

export const activitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }),
  z.object({ kind: z.literal('clearing') }),
  z.object({
    kind: z.literal('syncing'),
    progress: z
      .object({
        status: z.enum(['running', 'complete', 'incomplete']),
        emitted: count,
        committed: count,
      })
      .nullable(),
  }),
]);
export type Activity = z.infer<typeof activitySchema>;

export const articleSummarySchema = z.object({
  inputUrl: z.string(),
  pageUrl: z.string(),
  listingUrl: z.string(),
  lastModified: text,
  title: text,
  byline: text,
  publishedTime: text,
  excerpt: text,
  siteName: text,
  length: z.number(),
});
export type ArticleSummary = z.infer<typeof articleSummarySchema>;

export const articleSchema = articleSummarySchema.extend({
  url: z.string(),
  canonicalUrl: text,
  content: z.string(),
  markdown: z.string(),
  textContent: z.string(),
  lang: text,
  dir: text,
});
export type Article = z.infer<typeof articleSchema>;

const status = z.enum([
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
]);

export const attemptSchema = z.object({
  attempt_id: z.number(),
  started_at: z.string(),
  completed_at: text,
  status,
  error: text,
  failure_type: text,
  description: text,
  selection: z.json(),
  written_count: z.number().nullable(),
  deleted_count: z.number().nullable(),
  failures: z.json(),
});
export type Attempt = z.infer<typeof attemptSchema>;

export const historySchema = z.object({
  currentAsOf: text,
  lastSuccessfulSyncAt: text,
  attempts: z.array(attemptSchema),
});
export type History = z.infer<typeof historySchema>;

function isPattern(pattern: string): boolean {
  try {
    new URLPattern(pattern);
    return true;
  } catch {
    return false;
  }
}
