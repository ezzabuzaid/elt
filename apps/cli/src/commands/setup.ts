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
import type { ImportScope } from 'apple/sources/import-scope';
import {
  type Command as Declaration,
  InvalidArgumentError,
  Option,
} from 'commander';
import type { AppleApp, ChoiceOptions } from '../apps/apple-app.ts';
import type { Selection, Store } from '../store.ts';
import { Command, type Output } from './command.ts';
import type { SyncCommand } from './sync.ts';

type Narrowed = {
  app: AppleApp;
  scope: { -readonly [K in keyof ImportScope]: ImportScope[K] };
  attachments: boolean;
};

// setup --app notes --collection <id> --since 2025-01-01 --app mail: commander
// reads flags in order, so each narrowing flag applies to the --app before
// it. Without --app, a person at a terminal answers prompts instead.
export class SetupCommand extends Command {
  readonly name = 'setup';
  readonly summary =
    'Choose the apps to import, and narrow any of them; prompts when no --app is given';
  readonly #flagged: Narrowed[] = [];

  constructor(
    apps: readonly AppleApp[],
    readonly store: Store,
    readonly syncing: SyncCommand,
  ) {
    super(apps);
  }

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
        const { app, scope: narrowed } = current(flag);
        const scope = flag === 'account' ? 'accountIds' : 'collectionIds';
        if (!app.narrowsBy(scope))
          throw new InvalidArgumentError(
            `${app.title} cannot be narrowed by ${flag}; see: options ${app.name}`,
          );
        narrowed[scope] = [...(narrowed[scope] ?? []), id];
        return id;
      };
    const date =
      (flag: 'since' | 'until') =>
      (value: string): string => {
        const { app, scope } = current(flag);
        if (app.datedBy === null)
          throw new InvalidArgumentError(
            `${app.title} records have no date to narrow by`,
          );
        const instant = new Date(value);
        if (Number.isNaN(instant.getTime()))
          throw new InvalidArgumentError('Use YYYY-MM-DD');
        scope[flag === 'since' ? 'startAt' : 'endAt'] = instant.toISOString();
        return value;
      };
    declaration
      .addOption(
        new Option('--app <app>', 'an app to import; repeat for more').choices(
          this.appNames,
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
          'import records of the --app before it before this date',
        ).argParser(date('until')),
      )
      .option(
        '--no-attachments',
        'import the --app before it without attachment files',
      )
      .option('--sync', 'sync right after saving');
    declaration.on('option:app', (name: string) => {
      const app = this.app(name);
      if (this.#flagged.some((selection) => selection.app === app))
        declaration.error(`error: --app ${name} appears twice`);
      this.#flagged.push({ app, scope: {}, attachments: true });
    });
    declaration.on('option:no-attachments', () => {
      current('no-attachments').attachments = false;
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
    for (const { app, scope } of this.#flagged)
      if (backwards(scope))
        throw new Error(`${app.title}: --since must precede --until`);
    const selections = this.#flagged.map(({ app, scope, attachments }) => ({
      app: app.name,
      scope,
      attachments,
    }));
    this.store.select(selections);
    // A sync reports itself.
    if (sync) {
      await this.syncing.sync(undefined, false, interactive);
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
      this.store.selections().map((selection) => [selection.app, selection]),
    );
    intro('Apple setup');
    const chosen = await multiselect<AppleApp>({
      message: 'Which apps should be imported?',
      options: this.apps.map((app) => ({ value: app, label: app.title })),
      initialValues: this.apps.filter(({ name }) => previous.has(name)),
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
      const attachments = previous.get(app.name)?.attachments ?? true;
      if (!narrowing.includes(app)) {
        selections.push({ app: app.name, scope: {}, attachments });
        continue;
      }
      const scope = await this.#narrow(
        app,
        choices.get(app) ?? [],
        previous.get(app.name)?.scope ?? {},
      );
      if (scope === null) return cancelled();
      selections.push({ app: app.name, scope, attachments });
    }
    this.store.select(selections);

    const sync = await confirm({ message: 'Sync now?' });
    outro(
      `Saved ${selections.map(({ app, scope }) => this.app(app).titled(scope)).join(', ')}.`,
    );
    if (sync === true) await this.syncing.sync(undefined, false, true);
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
        const answer = await text({
          message: `${title}: ${datedBy} ${label} (YYYY-MM-DD, leave empty for no limit)`,
          initialValue: previous[bound]?.slice(0, 10) ?? '',
          validate: (value) =>
            !value || !Number.isNaN(new Date(value).getTime())
              ? undefined
              : 'Use YYYY-MM-DD',
        });
        if (isCancel(answer)) return null;
        if (answer) scope[bound] = new Date(answer).toISOString();
      }
    if (backwards(scope)) {
      log.warn(`${title}: the start must precede the end; try again.`);
      return this.#narrow(app, choices, previous);
    }
    return scope;
  }
}

const backwards = ({ startAt, endAt }: ImportScope) =>
  startAt !== undefined && endAt !== undefined && startAt >= endAt;

function cancelled(): void {
  cancel('Setup cancelled; nothing changed.');
  process.exitCode = 130;
}
