import { relative } from 'node:path';

import { table } from '../table.ts';
import { Command, type Output } from './command.ts';

const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function ago(instant: string | null): string {
  if (instant === null) return 'never';
  const seconds = Math.round((Date.parse(instant) - Date.now()) / 1000);
  for (const [unit, size] of [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ] as const)
    if (Math.abs(seconds) >= size)
      return relativeTime.format(Math.trunc(seconds / size), unit);
  return 'just now';
}

export class StatusCommand extends Command {
  readonly name = 'status';
  readonly summary =
    'List all connectors, whether they are enabled, and their sync status';

  protected configure(): void {}

  protected async run(): Promise<Output> {
    const statuses = this.imports.status();
    return {
      data: statuses,
      text: () => {
        if (statuses.length === 0) return 'No connectors are available.';
        const failures = statuses
          .filter(({ error }) => error !== null)
          .map(({ title, error }) => `\n${title}: ${error}`);
        return [
          table(
            [
              'Connector',
              'Configuration',
              'Sync',
              'Last success',
              'Current as of',
              'Scope',
              'Database',
            ],
            statuses.map((status) => [
              status.title,
              status.enabled ? 'enabled' : 'disabled',
              status.state ?? '—',
              status.enabled ? ago(status.lastSuccessAt) : '—',
              status.enabled ? ago(status.currentAsOf) : '—',
              status.selection,
              status.database === null
                ? ''
                : relative(process.cwd(), status.database),
            ]),
          ),
          ...failures,
        ].join('\n');
      },
    };
  }
}
