import type {
  ElicitRequestFormParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { Selection } from '@workspace/import-store';

import { type ApplePlugin, appSchema } from './apple-plugin.ts';
import {
  hasFullDiskAccess,
  openFullDiskAccessSettings,
} from './full-disk-access.ts';

export type Ask = (form: ElicitRequestFormParams) => Promise<ElicitResult>;

// Setup asks in one form which apps. Each chosen app is imported from all its
// accounts and collections with attachments (Calendar within its default
// window), or keeps a narrower selection the user asked for earlier. Each is
// opened first, so macOS asks for access now and a denied app is reported.
// Full Disk Access has no macOS prompt, so apps behind it are reported
// without opening them and a second form offers to open its Settings list.
// Cancelling leaves setup unchanged. It returns once the answers are saved;
// the server then imports them in the background.
export async function setUpWithForms(plugin: ApplePlugin, ask: Ask) {
  const previous = new Map(
    plugin
      .status()
      .apps.map(({ app, scope, includeAttachments }) => [
        app,
        { app, scope, includeAttachments },
      ]),
  );
  const picked = await ask({
    mode: 'form',
    message:
      'Choose the Apple apps Codex can read on this Mac. Each app is imported in full; macOS may ask for access to each one.',
    requestedSchema: {
      type: 'object',
      properties: {
        apps: {
          type: 'array',
          title: 'Apps',
          items: {
            anyOf: plugin.apps.map(({ name, title }) => ({
              const: name,
              title,
            })),
          },
          default: plugin.apps
            .map(({ name }) => name)
            .filter((name) => previous.has(name)),
        },
      },
      required: ['apps'],
    },
  });
  if (picked.action !== 'accept') return { changed: false, ...plugin.status() };
  const chosen = z.array(appSchema).parse(picked.content?.apps);
  const behindFullDiskAccess = chosen.filter(
    (app) => plugin.app(app).fullDiskAccess,
  );
  const blocked =
    behindFullDiskAccess.length > 0 && !(await hasFullDiskAccess())
      ? behindFullDiskAccess
      : [];
  // A selected app whose connector is not loaded is not in the form; it
  // keeps its selection rather than losing its import.
  const configuration: Selection[] = [...previous.values()].filter(
    ({ app }) => !plugin.apps.some(({ name }) => name === app),
  );
  const unavailable: { app: string; error: string; permissions: string }[] = [];
  for (const app of chosen) {
    try {
      if (blocked.includes(app))
        throw new Error('ChatGPT does not have Full Disk Access.');
      await plugin.options(app);
      configuration.push(
        previous.get(app) ?? { app, scope: {}, includeAttachments: true },
      );
    } catch (error) {
      unavailable.push({
        app,
        error: error instanceof Error ? error.message : String(error),
        permissions: plugin.app(app).guidance(),
      });
      const kept = previous.get(app);
      if (kept !== undefined) configuration.push(kept);
    }
  }
  const saved = plugin.configure({ apps: configuration });
  if (blocked.length === 0) return { changed: true, unavailable, ...saved };
  return {
    changed: true,
    unavailable,
    openedFullDiskAccess: await offerFullDiskAccess(
      ask,
      blocked.map((app) => plugin.app(app).title),
    ),
    ...saved,
  };
}

async function offerFullDiskAccess(ask: Ask, titles: readonly string[]) {
  const listed = new Intl.ListFormat('en', { type: 'conjunction' }).format(
    titles,
  );
  const answer = await ask({
    mode: 'form',
    message: `${listed} ${titles.length === 1 ? 'needs' : 'need'} Full Disk Access, which macOS never asks for. Turn on ChatGPT in the list that opens, then quit and reopen ChatGPT and run Set up Apple again.`,
    requestedSchema: {
      type: 'object',
      properties: {
        openSettings: {
          type: 'boolean',
          title: 'Open Full Disk Access in System Settings',
          default: true,
        },
      },
    },
  });
  // A client may leave an untouched field out, so only unticking declines.
  if (answer.action !== 'accept' || answer.content?.openSettings === false)
    return false;
  await openFullDiskAccessSettings();
  return true;
}
