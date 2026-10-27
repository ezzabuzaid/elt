import { z } from 'zod';

import {
  type Settings,
  articleSchema,
  articleSummarySchema,
  historySchema,
  settingsSchema,
} from '../../src/contract.ts';

// validate() from @sdk-it/hono puts each field's errors, keyed by field, in
// cause.errors; other failures carry only error.
const failure = z.object({
  error: z.string(),
  cause: z
    .object({
      errors: z.record(
        z.string(),
        z.array(z.object({ path: z.string(), message: z.string() })),
      ),
    })
    .optional(),
});

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  const body: unknown = [202, 204].includes(response.status)
    ? null
    : await response.json();
  if (!response.ok) {
    const { error, cause } = failure.parse(body);
    const fields =
      cause === undefined ? [] : Object.values(cause.errors).flat();
    throw new Error(
      fields.length === 0
        ? error
        : fields.map(({ path, message }) => `${message} at ${path}`).join('\n'),
    );
  }
  return body;
}

export const api = {
  settings: async () => settingsSchema.parse(await request('/api/settings')),
  saveSettings: async (settings: Settings) =>
    settingsSchema.parse(
      await request('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      }),
    ),
  sync: () => request('/api/sync', { method: 'POST' }),
  clear: () => request('/api/clear', { method: 'POST' }),
  articles: async () =>
    z.array(articleSummarySchema).parse(await request('/api/articles')),
  article: async (inputUrl: string, articleUrl: string) =>
    articleSchema.parse(
      await request(
        `/api/article?${new URLSearchParams({ inputUrl, articleUrl })}`,
      ),
    ),
  history: async () => historySchema.parse(await request('/api/history')),
};
