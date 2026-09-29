import type {
  ElicitRequestFormParams,
  ElicitResult,
  PrimitiveSchemaDefinition,
} from '@modelcontextprotocol/sdk/types.js';
import type { ApplePlugin } from './apple-plugin.ts';
import { type App, appNames, apps, type ChoiceRows } from './apps.ts';
import { type AppConfiguration, appSchema } from './settings.ts';

export type Ask = (form: ElicitRequestFormParams) => Promise<ElicitResult>;
type Answer = NonNullable<ElicitResult['content']>;

// Forms show local calendar days; scopes hold UTC instants with an exclusive end.
const pad = (value: number) => String(value).padStart(2, '0');
const day = (instant: Date) =>
  `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`;
const midnight = (date: string, days = 0) => {
  const instant = new Date(`${date}T00:00:00`);
  instant.setDate(instant.getDate() + days);
  return instant.toISOString();
};
const capitalized = (text: string) =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

function scopeForm(app: App, rows: ChoiceRows, previous?: AppConfiguration) {
  const definition = apps[app];
  const offered = definition.choices
    .map((choice) => {
      const options = (rows[choice.stream] ?? [])
        .map((row) => ({
          const: choice.id(row),
          title: choice.label(row, rows),
        }))
        .sort((left, right) => left.title.localeCompare(right.title));
      return { choice, options, ids: options.map((option) => option.const) };
    })
    .filter(({ ids }) => ids.length > 0);
  const properties: Record<string, PrimitiveSchemaDefinition> = {};
  for (const { choice, options, ids } of offered) {
    const earlier = previous?.scope[choice.scope]?.filter((id) =>
      ids.includes(id),
    );
    properties[choice.stream] = {
      type: 'array',
      title: capitalized(choice.stream),
      minItems: 1,
      items: { anyOf: options },
      default: earlier?.length ? earlier : ids,
    };
  }
  const { startAt, endAt } = {
    ...definition.defaultScope?.(),
    ...previous?.scope,
  };
  if (definition.datedBy !== null) {
    properties.from = {
      type: 'string',
      format: 'date',
      title: 'From',
      description: `First day to include, by ${definition.datedBy}. Leave empty to start at the earliest.`,
      ...(startAt && { default: day(new Date(startAt)) }),
    };
    properties.until = {
      type: 'string',
      format: 'date',
      title: 'Until',
      description: 'Last day to include. Leave empty to include the latest.',
      ...(endAt && { default: day(new Date(Date.parse(endAt) - 1)) }),
    };
  }
  properties.attachments = {
    type: 'boolean',
    title: 'Copy attachments',
    default: previous?.includeAttachments ?? true,
  };
  const form: ElicitRequestFormParams = {
    mode: 'form',
    message: [
      `${definition.title}: choose what Codex can read. With everything checked, items added later are included too.`,
      definition.note,
    ]
      .filter(Boolean)
      .join(' '),
    requestedSchema: {
      type: 'object',
      properties,
      required: offered.map(({ choice }) => choice.stream),
    },
  };
  const read = (answer: Answer): AppConfiguration => {
    const scope: AppConfiguration['scope'] = {};
    for (const { choice, ids } of offered) {
      const chosen = answer[choice.stream] as string[];
      if (ids.some((id) => !chosen.includes(id))) scope[choice.scope] = chosen;
    }
    if (typeof answer.from === 'string' && answer.from)
      scope.startAt = midnight(answer.from);
    if (typeof answer.until === 'string' && answer.until)
      scope.endAt = midnight(answer.until, 1);
    return { app, scope, includeAttachments: answer.attachments !== false };
  };
  return { form, read };
}

// Setup where the user answers in forms: the apps first, then one form per
// app. Declining an app's form skips it; cancelling leaves setup unchanged.
export async function setUpWithForms(plugin: ApplePlugin, ask: Ask) {
  const previous = new Map(
    plugin
      .status()
      .apps.map(({ app, scope, includeAttachments }) => [
        app,
        { app, scope, includeAttachments },
      ]),
  );
  const unchanged = () => ({ changed: false, ...plugin.status() });
  const picked = await ask({
    mode: 'form',
    message:
      'Choose the Apple apps Codex can read on this Mac. macOS may ask for access to each app.',
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
  if (picked.action !== 'accept') return unchanged();
  const configuration: AppConfiguration[] = [];
  const skipped: App[] = [];
  const unavailable: { app: App; error: string; permissions: string }[] = [];
  for (const app of appSchema.array().parse(picked.content?.apps)) {
    let rows: ChoiceRows;
    try {
      rows = (await plugin.options(app)).choices;
    } catch (error) {
      unavailable.push({
        app,
        error: error instanceof Error ? error.message : String(error),
        permissions: apps[app].permissions,
      });
      const kept = previous.get(app);
      if (kept !== undefined) configuration.push(kept);
      continue;
    }
    const { form, read } = scopeForm(app, rows, previous.get(app));
    const answer = await ask(form);
    if (answer.action === 'cancel') return unchanged();
    if (answer.action === 'decline' || answer.content === undefined) {
      skipped.push(app);
      continue;
    }
    configuration.push(read(answer.content));
  }
  plugin.configure({ apps: configuration });
  return { changed: true, skipped, unavailable, ...(await plugin.sync()) };
}
