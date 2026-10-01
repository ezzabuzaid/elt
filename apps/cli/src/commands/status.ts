import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import type { AppleApp } from '../apps/apple-app.ts';
import type { Store } from '../store.ts';
import { table } from '../table.ts';
import { Command, type Output } from './command.ts';

type AppStatus = {
  readonly app: string;
  readonly selection: string;
  readonly database: string | null;
  // never: not synced yet; interrupted: a pass was running when its sync stopped.
  readonly state:
    | 'never'
    | 'running'
    | 'interrupted'
    | 'succeeded'
    | 'partial'
    | 'failed';
  readonly completedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly error: string | null;
  readonly streams: readonly {
    readonly stream: string;
    readonly state: string;
    readonly lastSuccessAt: string | null;
  }[];
};

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
    "Show each selected app's latest pass, last success and database";

  constructor(
    apps: readonly AppleApp[],
    readonly store: Store,
  ) {
    super(apps);
  }

  protected configure(): void {}

  protected async run(): Promise<Output> {
    const statuses = this.#read();
    return {
      data: statuses,
      text: () => {
        if (statuses.length === 0) return 'No apps are set up. Run: setup';
        const failures = statuses
          .filter(({ error }) => error !== null)
          .map(
            ({ app, error }) =>
              `\n${this.app(app).title}: ${error}\n${this.app(app).guidance()}`,
          );
        return [
          table(
            ['App', 'State', 'Last success', 'Scope', 'Database'],
            statuses.map((status) => [
              this.app(status.app).title,
              status.state,
              ago(status.lastSuccessAt),
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

  // Each selected app as its own data.sqlite records it: the latest pass, the
  // last successful one, and every stream's own latest outcome; or why its
  // connection could not be built, which no pass recorded.
  #read(): AppStatus[] {
    const syncing = this.store.busy();
    return this.store.selections().map((selection) => {
      const path = this.store.database(selection);
      const base = {
        app: selection.app,
        selection: this.app(selection.app).describe(selection.scope),
        database: existsSync(path) ? path : null,
      };
      const never = {
        ...base,
        state: 'never' as const,
        completedAt: null,
        lastSuccessAt: null,
        error: null,
        streams: [],
      };
      const failure = this.store.connectionFailure(selection);
      if (failure !== undefined)
        return {
          ...never,
          state: 'failed' as const,
          completedAt: failure.failedAt,
          error: this.app(selection.app).failure(new Error(failure.error)),
        };
      if (base.database === null) return never;
      // A sync installs the history views before it writes anything else.
      using database = this.store.read(selection);
      const latest = database
        .prepare(
          'SELECT status, completed_at, error, last_successful_sync_at FROM sync_status WHERE connector = ?',
        )
        .get(selection.app) as
        | {
            status: AppStatus['state'];
            completed_at: string | null;
            error: string | null;
            last_successful_sync_at: string | null;
          }
        | undefined;
      // Installed, but no pass began yet.
      if (latest === undefined) return never;
      return {
        ...base,
        state:
          latest.status === 'running' && !syncing
            ? 'interrupted'
            : latest.status,
        completedAt: latest.completed_at,
        lastSuccessAt: latest.last_successful_sync_at,
        error: latest.error,
        streams: (
          database
            .prepare(
              'SELECT stream, status, last_successful_sync_at FROM stream_status WHERE connector = ? ORDER BY stream',
            )
            .all(selection.app) as {
            stream: string;
            status: string;
            last_successful_sync_at: string | null;
          }[]
        ).map(({ stream, status, last_successful_sync_at }) => ({
          stream,
          state: status,
          lastSuccessAt: last_successful_sync_at,
        })),
      };
    });
  }
}
