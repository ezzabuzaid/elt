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

import type {
  AppleConnector,
  ChoiceOptions,
} from '@workspace/connector-apple-connector/apple-connector';
import { selectionProblems } from '@workspace/settings';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import type { Selection } from '../imports.ts';
import { SyncReport } from '../sync-report.ts';
import { Command, type Output } from './command.ts';

type Narrowed = {
  connector: AppleConnector;
  scope: { -readonly [K in keyof ImportScope]: ImportScope[K] };
  includeAttachments: boolean;
};

// setup --connector notes --collection <id> --since 2025-01-01 --connector
// mail: commander reads flags in order, so each narrowing flag applies to the
// --connector before it. Without --connector, a person at a terminal answers
// prompts instead.
export class SetupCommand extends Command {
  readonly name = 'setup';
  readonly summary =
    'Choose the connectors to import, and narrow any of them; prompts when no --connector is given';
  readonly #flagged: Narrowed[] = [];

  protected configure(declaration: Declaration): void {
    const current = (flag: string) => {
      const selection = this.#flagged.at(-1);
      if (selection === undefined)
        throw new InvalidArgumentError(
          `--${flag} must follow the --connector it narrows`,
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
        new Option(
          '--connector <connector>',
          'a connector to import; repeat for more',
        ).choices(this.imports.names),
      )
      .addOption(
        new Option(
          '--account <id>',
          'import only this account of the --connector before it',
        ).argParser(narrow('account')),
      )
      .addOption(
        new Option(
          '--collection <id>',
          'import only this folder, mailbox, chat, calendar, list or profile of the --connector before it',
        ).argParser(narrow('collection')),
      )
      .addOption(
        new Option(
          '--since <date>',
          "import records of the --connector before it from this day (YYYY-MM-DD, on this Mac's clock)",
        ).argParser(date('since')),
      )
      .addOption(
        new Option(
          '--until <date>',
          "import records of the --connector before it through this day (YYYY-MM-DD, on this Mac's clock)",
        ).argParser(date('until')),
      )
      .option(
        '--no-attachments',
        'import the --connector before it without attachment files',
      )
      .option('--sync', 'sync right after saving');
    declaration.on('option:connector', (name: string) => {
      this.#flagged.push({
        connector: this.imports.connector(name),
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
    if (!interactive)
      throw new Error('Name the connectors to import with --connector');
    await this.#fromPrompts();
    return undefined;
  }

  async #fromFlags(
    sync: boolean,
    interactive: boolean,
  ): Promise<Output | undefined> {
    const selections = this.#flagged.map(
      ({ connector, scope, includeAttachments }) => ({
        connector: connector.name,
        scope,
        includeAttachments,
      }),
    );
    await this.imports.select(selections);
    // A sync reports itself.
    if (sync) {
      await this.imports.sync(undefined, new SyncReport(interactive));
      return undefined;
    }
    return {
      data: { connectors: selections },
      text: () =>
        `Saved ${this.#flagged.map(({ connector, scope }) => connector.titled(scope)).join(', ')}.`,
    };
  }

  // Which connectors, then which of them to narrow and how. Each chosen
  // connector is opened first, so macOS asks for access now and a refusal is
  // named. Cancelling saves nothing; once saved, declining only skips the sync.
  async #fromPrompts(): Promise<void> {
    const previous = new Map(
      this.imports
        .selections()
        .map((selection) => [selection.connector, selection]),
    );
    intro('Apple setup');
    const chosen = await multiselect<AppleConnector>({
      message: 'Which connectors should be imported?',
      options: this.imports.connectors.map((connector) => ({
        value: connector,
        label: connector.title,
      })),
      initialValues: this.imports.connectors.filter(({ name }) =>
        previous.has(name),
      ),
      required: true,
    });
    if (isCancel(chosen)) return cancelled();

    const checking = spinner();
    checking.start('Checking access');
    const choices = new Map<AppleConnector, ChoiceOptions[]>();
    const denied: string[] = [];
    for (const connector of chosen)
      try {
        choices.set(connector, await connector.listChoices());
      } catch (error) {
        denied.push(`${connector.title}: ${connector.failure(error)}`);
      }
    checking.stop(
      `Checked access to ${chosen.map(({ title }) => title).join(', ')}`,
    );
    for (const warning of denied) log.warn(warning);

    const narrowable = chosen.filter(
      (connector) =>
        choices.get(connector)?.some(({ options }) => options.length > 0) ||
        connector.datedBy !== null,
    );
    const narrowing =
      narrowable.length === 0
        ? []
        : await multiselect<AppleConnector>({
            message: 'Narrow any connector? (leave empty to import everything)',
            options: narrowable.map((connector) => ({
              value: connector,
              label: connector.title,
            })),
            initialValues: narrowable.filter(
              ({ name }) =>
                Object.keys(previous.get(name)?.scope ?? {}).length > 0,
            ),
            required: false,
          });
    if (isCancel(narrowing)) return cancelled();

    const selections: Selection[] = [];
    for (const connector of chosen) {
      const includeAttachments =
        previous.get(connector.name)?.includeAttachments ?? true;
      if (!narrowing.includes(connector)) {
        selections.push({
          connector: connector.name,
          scope: {},
          includeAttachments,
        });
        continue;
      }
      const scope = await this.#narrow(
        connector,
        choices.get(connector) ?? [],
        previous.get(connector.name)?.scope ?? {},
      );
      if (scope === null) return cancelled();
      selections.push({ connector: connector.name, scope, includeAttachments });
    }
    await this.imports.select(selections);

    const sync = await confirm({ message: 'Sync now?' });
    outro(
      `Saved ${selections.map(({ connector, scope }) => this.imports.connector(connector).titled(scope)).join(', ')}.`,
    );
    if (sync === true) await this.imports.sync(undefined, new SyncReport(true));
  }

  async #narrow(
    connector: AppleConnector,
    choices: readonly ChoiceOptions[],
    previous: ImportScope,
  ): Promise<ImportScope | null> {
    const { title, datedBy } = connector;
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
      [{ connector: connector.name, scope, includeAttachments: true }],
      () => connector,
    );
    if (problem !== undefined) {
      log.warn(`${problem}; try again.`);
      return this.#narrow(connector, choices, previous);
    }
    return scope;
  }
}

function cancelled(): void {
  cancel('Setup cancelled; nothing changed.');
  process.exitCode = 130;
}

// The scope bound a typed day names on this Mac's clock: since starts at that
// day's midnight, and until takes in the whole day, so its exclusive endAt is
// the next day's midnight. null when the answer is not a calendar date.
function boundOf(bound: 'startAt' | 'endAt', day: string): string | null {
  const [year, month, date] = day.split('-').map(Number);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !year || !month || !date) return null;
  const instant = new Date(year, month - 1, date);
  // Date rolls 2026-02-30 over to March; only a day that reads back as typed
  // is a calendar date.
  if (localDay(instant) !== day) return null;
  if (bound === 'endAt') instant.setDate(instant.getDate() + 1);
  return instant.toISOString();
}

// The day a saved bound shows as, the inverse of boundOf.
function dayOf(bound: 'startAt' | 'endAt', instant: string): string {
  const day = new Date(instant);
  if (bound === 'endAt') day.setDate(day.getDate() - 1);
  return localDay(day);
}

// The calendar day an instant falls on, on this Mac's clock.
function localDay(instant: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`;
}
