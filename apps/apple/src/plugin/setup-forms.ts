import type {
  ElicitRequestFormParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ApplePlugin } from './apple-plugin.ts';
import { type App, appNames, apps } from './apps.ts';
import { type AppConfiguration, appSchema } from './settings.ts';

export type Ask = (form: ElicitRequestFormParams) => Promise<ElicitResult>;

// Setup in one form: which apps. Each chosen app is imported from all its
// accounts and collections with attachments (Calendar within its default
// window), or keeps a narrower selection the user asked for earlier. Each is
// opened first, so macOS asks for access now and a denied app is reported.
// Cancelling leaves setup unchanged. It returns once the answers are saved;
// the leading server imports them.
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
            anyOf: appNames.map((app) => ({
              const: app,
              title: apps[app].title,
            })),
          },
          default: [...previous.keys()],
        },
      },
      required: ['apps'],
    },
  });
  if (picked.action !== 'accept') return { changed: false, ...plugin.status() };
  const configuration: AppConfiguration[] = [];
  const unavailable: { app: App; error: string; permissions: string }[] = [];
  for (const app of appSchema.array().parse(picked.content?.apps)) {
    try {
      await plugin.options(app);
      configuration.push(
        previous.get(app) ?? { app, scope: {}, includeAttachments: true },
      );
    } catch (error) {
      unavailable.push({
        app,
        error: error instanceof Error ? error.message : String(error),
        permissions: apps[app].permissions,
      });
      const kept = previous.get(app);
      if (kept !== undefined) configuration.push(kept);
    }
  }
  return {
    changed: true,
    unavailable,
    ...plugin.configure({ apps: configuration }),
  };
}
