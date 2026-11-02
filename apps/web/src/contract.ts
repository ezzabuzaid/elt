import { z } from 'zod';

const text = z.string().nullable();
const status = z.enum([
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
]);

export const settingsSchema = z.object({
  inputs: z.array(z.url({ protocol: /^https?$/ })),
  include: z.array(
    z.string().refine(isPattern, { error: 'Not a URL pattern' }),
  ),
});
export type Settings = z.infer<typeof settingsSchema>;

// One URL of a crawl once its request ended (milliseconds), and, for a page,
// what the source extracted from it. A request failed when it got no answer,
// or a 4xx or 5xx one.
export const crawlRequestSchema = z.object({
  id: z.number(),
  url: z.string(),
  list: z.boolean(),
  waited: z.number(),
  failed: z.boolean(),
  outcome: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('answered'),
      status: z.number(),
      // An answer that the HTTP cache or the origin's record gave took none.
      duration: z.number().nullable(),
    }),
    z.object({ kind: z.literal('errored'), error: z.string() }),
  ]),
  page: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('extracted'), records: z.number() }),
      z.object({ kind: z.literal('unchanged') }),
    ])
    .nullable(),
});
export type CrawlRequest = z.infer<typeof crawlRequestSchema>;

// The last Sync, as it runs and once it ended (epoch milliseconds). A crawl
// has no total: each page it reads can add URLs to its frontier, so waiting
// is what the open crawls still hold, not what is left.
export const runSchema = z.object({
  startedAt: z.number(),
  requests: z.number(),
  failed: z.number(),
  waiting: z.number(),
  held: z.number(),
  pages: z.number(),
  unchanged: z.number(),
  // Records committed to the articles table; a page that gives an article
  // already there writes over its row.
  written: z.number(),
  blocks: z.array(z.object({ origin: z.string(), until: z.number() })),
  // When the earliest page of the ended crawls is due again: a Sync before
  // then reads nothing of it.
  nextDue: z.number().nullable(),
  // The latest requests, newest first.
  log: z.array(crawlRequestSchema),
  ended: z
    .object({
      at: z.number(),
      status: status.exclude(['running']),
      error: text,
    })
    .nullable(),
});
export type Run = z.infer<typeof runSchema>;

// Null until the first Sync since the server started.
export const activitySchema = runSchema.nullable();
export type Activity = z.infer<typeof activitySchema>;

export const articleSummarySchema = z.object({
  inputUrl: z.string(),
  articleUrl: z.string(),
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
