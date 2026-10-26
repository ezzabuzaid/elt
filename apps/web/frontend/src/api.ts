import { z } from 'zod';

import {
  type Settings,
  articleSchema,
  articleSummarySchema,
  historySchema,
  settingsSchema,
} from '../../src/contract.ts';

const failure = z.object({ error: z.string() });

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  const body: unknown = response.status === 202 ? null : await response.json();
  if (!response.ok) throw new Error(failure.parse(body).error);
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
