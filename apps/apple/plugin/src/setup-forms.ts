import type {
  ElicitRequestFormParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { Selection } from '@workspace/settings';

import { type ApplePlugin, connectorSchema } from './apple-plugin.ts';
import {
  hasFullDiskAccess,
  openFullDiskAccessSettings,
} from './full-disk-access.ts';

export type Ask = (form: ElicitRequestFormParams) => Promise<ElicitResult>;

// Setup asks in one form which connectors. Each chosen connector is imported
// from all its accounts and collections with attachments (Calendar within its
// default window), or keeps a narrower selection the user asked for earlier.
// Each is opened first, so macOS asks for access now and a denied connector is
// reported. Full Disk Access has no macOS prompt, so connectors behind it are
// reported without opening them and a second form offers to open its Settings
// list. Cancelling leaves setup unchanged. It returns once the answers are
// saved; the server then imports them in the background.
export async function setUpWithForms(plugin: ApplePlugin, ask: Ask) {
  const previous = new Map(
    (await plugin.status()).connectors.map(
      ({ connector, scope, includeAttachments }) => [
        connector,
        { connector, scope, includeAttachments },
      ],
    ),
  );
  const picked = await ask({
    mode: 'form',
    message:
      'Choose the Apple connectors Codex can read on this Mac. Each connector is imported in full; macOS may ask for access to each one.',
    requestedSchema: {
      type: 'object',
      properties: {
        connectors: {
          type: 'array',
          title: 'Connectors',
          items: {
            anyOf: plugin.connectors.map(({ name, title }) => ({
              const: name,
              title,
            })),
          },
          default: plugin.connectors
            .map(({ name }) => name)
            .filter((name) => previous.has(name)),
        },
      },
      required: ['connectors'],
    },
  });
  if (picked.action !== 'accept')
    return { changed: false, ...(await plugin.status()) };
  const chosen = z.array(connectorSchema).parse(picked.content?.connectors);
  const behindFullDiskAccess = chosen.filter(
    (name) => plugin.connector(name).fullDiskAccess,
  );
  const blocked =
    behindFullDiskAccess.length > 0 && !(await hasFullDiskAccess())
      ? behindFullDiskAccess
      : [];
  // A selected connector that is not loaded is not in the form; it keeps its
  // selection rather than losing its import.
  const configuration: Selection[] = [...previous.values()].filter(
    ({ connector }) =>
      !plugin.connectors.some(({ name }) => name === connector),
  );
  const unavailable: {
    connector: string;
    error: string;
    permissions: string;
  }[] = [];
  for (const connector of chosen) {
    try {
      if (blocked.includes(connector))
        throw new Error('ChatGPT does not have Full Disk Access.');
      await plugin.options(connector);
      configuration.push(
        previous.get(connector) ?? {
          connector,
          scope: {},
          includeAttachments: true,
        },
      );
    } catch (error) {
      unavailable.push({
        connector,
        error: error instanceof Error ? error.message : String(error),
        permissions: plugin.connector(connector).guidance(),
      });
      const kept = previous.get(connector);
      if (kept !== undefined) configuration.push(kept);
    }
  }
  const saved = await plugin.configure({ connectors: configuration });
  if (blocked.length === 0) return { changed: true, unavailable, ...saved };
  return {
    changed: true,
    unavailable,
    openedFullDiskAccess: await offerFullDiskAccess(
      ask,
      blocked.map((name) => plugin.connector(name).title),
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
