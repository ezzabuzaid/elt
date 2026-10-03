import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  outro,
  spinner,
  text,
} from '@clack/prompts';
import {
  type Command as Declaration,
  InvalidArgumentError,
  Option,
} from 'commander';

import type { AppleApp, ChoiceOptions } from '@workspace/apple/apps/apple-app';
import { type ImportScope, selectionProblems } from '@workspace/import-store';

import type { Selection } from '../imports.ts';
import { SyncReport } from '../sync-report.ts';
import { Command, type Output } from './command.ts';

type Narrowed = {
  app: AppleApp;
  scope: { -readonly [K in keyof ImportScope]: ImportScope[K] };
  includeAttachments: boolean;
};

// setup --app notes --collection <id> --since 2025-01-01 --app mail: commander
// reads flags in order, so each narrowing flag applies to the --app before
// it. Without --app, a person at a terminal answers prompts instead.
export class SetupCommand extends Command {
  readonly name = 'setup';
  readonly summary =
    'Choose the apps to import, and narrow any of them; prompts when no --app is given';
  readonly #flagged: Narrowed[] = [];

  protected configure(declaration: Declaration): void {
    const current = (flag: string) => {
      const selection = this.#flagged.at(-1);
      if (selection === undefined)
        throw new InvalidArgumentError(
          `--${flag} must follow the --app it narrows`,
        );
      return selection;
    };
    const narrow =
      (flag: 'account' | 'collection') =>
      (id: string): string => {
        const { scope: narrowed } = current(flag);
        const scope = flag === 'account' ? 'accountIds' : 'collectionIds';
        narrowed[scope] = [...(narrowed[scope] ?? []), id];
        return id;
      };
    const date =
      (flag: 'since' | 'until') =>
      (value: string): string => {
        const { scope } = current(flag);
        const bound = flag === 'since' ? 'startAt' : 'endAt';
        const instant = boundOf(bound, value);
        if (instant === null) throw new InvalidArgumentError('Use YYYY-MM-DD');
        scope[bound] = instant;
        return value;
      };
    declaration
      .addOption(
        new Option('--app <app>', 'an app to import; repeat for more').choices(
          this.imports.names,
        ),
      )
      .addOption(
        new Option(
          '--account <id>',
          'import only this account of the --app before it',
        ).argParser(narrow('account')),
      )
      .addOption(
        new Option(
          '--collection <id>',
          'import only this folder, mailbox, chat, calendar, list or profile of the --app before it',
        ).argParser(narrow('collection')),
      )
      .addOption(
        new Option(
          '--since <date>',
          'import records of the --app before it from this date',
        ).argParser(date('since')),
      )
      .addOption(
        new Option(
          '--until <date>',
          'import records of the --app before it through this date',
        ).argParser(date('until')),
      )
      .option(
        '--no-attachments',
        'import the --app before it without attachment files',
      )
      .option('--sync', 'sync right after saving');
    declaration.on('option:app', (name: string) => {
      this.#flagged.push({
        app: this.imports.app(name),
        scope: {},
        includeAttachments: true,
      });
    });
    declaration.on('option:no-attachments', () => {
      current('no-attachments').includeAttachments = false;
    });
  }

  protected async run(
    declaration: Declaration,
    interactive: boolean,
  ): Promise<Output | undefined> {
    if (this.#flagged.length > 0)
      return this.#fromFlags(declaration.opts().sync === true, interactive);
    if (!interactive) throw new Error('Name the apps to import with --app');
    await this.#fromPrompts();
    return undefined;
  }

  async #fromFlags(
    sync: boolean,
    interactive: boolean,
  ): Promise<Output | undefined> {
    const selections = this.#flagged.map(
      ({ app, scope, includeAttachments }) => ({
        app: app.name,
        scope,
        includeAttachments,
      }),
    );
    this.imports.select(selections);
    // A sync reports itself.
    if (sync) {
      await this.imports.sync(undefined, new SyncReport(interactive));
      return undefined;
    }
    return {
      data: { apps: selections },
      text: () =>
        `Saved ${this.#flagged.map(({ app, scope }) => app.titled(scope)).join(', ')}.`,
    };
  }

  // Which apps, then which of them to narrow and how. Each chosen app is
  // opened first, so macOS asks for access now and a refusal is named.
  // Cancelling saves nothing; once saved, declining only skips the sync.
  async #fromPrompts(): Promise<void> {
    const previous = new Map(
      this.imports.selections().map((selection) => [selection.app, selection]),
    );
    intro('Apple setup');
    const chosen = await multiselect<AppleApp>({
      message: 'Which apps should be imported?',
      options: this.imports.apps.map((app) => ({
        value: app,
        label: app.title,
      })),
      initialValues: this.imports.apps.filter(({ name }) => previous.has(name)),
      required: true,
    });
    if (isCancel(chosen)) return cancelled();

    const checking = spinner();
    checking.start('Checking access');
    const choices = new Map<AppleApp, ChoiceOptions[]>();
    const denied: string[] = [];
    for (const app of chosen)
      try {
        choices.set(app, await app.listChoices());
      } catch (error) {
        denied.push(`${app.title}: ${app.failure(error)}`);
      }
    checking.stop(
      `Checked access to ${chosen.map(({ title }) => title).join(', ')}`,
    );
    for (const warning of denied) log.warn(warning);

    const narrowable = chosen.filter(
      (app) =>
        choices.get(app)?.some(({ options }) => options.length > 0) ||
        app.datedBy !== null,
    );
    const narrowing =
      narrowable.length === 0
        ? []
        : await multiselect<AppleApp>({
            message: 'Narrow any app? (leave empty to import everything)',
            options: narrowable.map((app) => ({
              value: app,
              label: app.title,
            })),
            initialValues: narrowable.filter(
              ({ name }) =>
                Object.keys(previous.get(name)?.scope ?? {}).length > 0,
            ),
            required: false,
          });
    if (isCancel(narrowing)) return cancelled();

    const selections: Selection[] = [];
    for (const app of chosen) {
      const includeAttachments =
        previous.get(app.name)?.includeAttachments ?? true;
      if (!narrowing.includes(app)) {
        selections.push({ app: app.name, scope: {}, includeAttachments });
        continue;
      }
      const scope = await this.#narrow(
        app,
        choices.get(app) ?? [],
        previous.get(app.name)?.scope ?? {},
      );
      if (scope === null) return cancelled();
      selections.push({ app: app.name, scope, includeAttachments });
    }
    this.imports.select(selections);

    const sync = await confirm({ message: 'Sync now?' });
    outro(
      `Saved ${selections.map(({ app, scope }) => this.imports.app(app).titled(scope)).join(', ')}.`,
    );
    if (sync === true) await this.imports.sync(undefined, new SyncReport(true));
  }

  async #narrow(
    app: AppleApp,
    choices: readonly ChoiceOptions[],
    previous: ImportScope,
  ): Promise<ImportScope | null> {
    const { title, datedBy } = app;
    const scope: Narrowed['scope'] = {};
    for (const choice of choices) {
      if (choice.options.length === 0) continue;
      const ids = await multiselect<string>({
        message: `${title}: ${choice.title} (leave empty for all)`,
        options: choice.options.map(({ id, label }) => ({ value: id, label })),
        initialValues: (previous[choice.scope] ?? []).filter((id) =>
          choice.options.some((option) => option.id === id),
        ),
        required: false,
      });
      if (isCancel(ids)) return null;
      if (ids.length > 0)
        scope[choice.scope] = [...(scope[choice.scope] ?? []), ...ids];
    }
    if (datedBy !== null)
      for (const [bound, label] of [
        ['startAt', 'since'],
        ['endAt', 'until'],
      ] as const) {
        const saved = previous[bound];
        const answer = await text({
          message: `${title}: ${datedBy} ${label} (YYYY-MM-DD, leave empty for no limit)`,
          initialValue: saved === undefined ? '' : dayOf(bound, saved),
          validate: (value) =>
            !value || boundOf(bound, value) !== null
              ? undefined
              : 'Use YYYY-MM-DD',
        });
        if (isCancel(answer)) return null;
        const instant = answer ? boundOf(bound, answer) : null;
        if (instant !== null) scope[bound] = instant;
      }
    const [problem] = selectionProblems(
      [{ app: app.name, scope, includeAttachments: true }],
      () => app,
    );
    if (problem !== undefined) {
      log.warn(`${problem}; try again.`);
      return this.#narrow(app, choices, previous);
    }
    return scope;
  }
}

function cancelled(): void {
  cancel('Setup cancelled; nothing changed.');
  process.exitCode = 130;
}

// The scope bound a typed day names: since starts at that day, and until
// takes in the whole day, so its exclusive endAt is the next day's start.
// null when the answer is not a calendar date.
function boundOf(bound: 'startAt' | 'endAt', day: string): string | null {
  const instant = new Date(`${day}T00:00:00.000Z`);
  // Date rolls 2026-02-30 over to March; only a day that reads back as typed
  // is a calendar date.
  if (
    Number.isNaN(instant.getTime()) ||
    instant.toISOString().slice(0, 10) !== day
  )
    return null;
  if (bound === 'endAt') instant.setUTCDate(instant.getUTCDate() + 1);
  return instant.toISOString();
}

// The day a saved bound shows as, the inverse of boundOf.
function dayOf(bound: 'startAt' | 'endAt', instant: string): string {
  const day = new Date(instant);
  if (bound === 'endAt') day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}
