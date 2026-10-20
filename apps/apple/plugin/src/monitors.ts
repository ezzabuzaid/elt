import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { Declaration } from '@zukhruf/sqlite-drift';
import {
  Federation,
  type Locate,
  type Query,
} from '@zukhruf/sqlite-federation';
import { transaction } from '@zukhruf/sqlite-transaction';
import { z } from 'zod';

import { type Condition, Eca, type Rule } from '@workspace/eca';

// A monitor package's package.json: what the page shows of it, read without
// running its code, and the entry whose default export has evaluate(sql).
const manifestSchema = z.object({
  type: z.literal('module'),
  exports: z.string().startsWith('./'),
  contextCompiler: z.strictObject({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    title: z.string().min(1),
    description: z.string().min(1),
    instruction: z.string().min(1),
  }),
});

// What a condition an agent wrote resolves to, checked at the boundary since
// eca only sees the condition's own claims.
const matchesSchema = z.array(z.object({ key: z.string(), data: z.unknown() }));

type MonitorManifest = z.infer<typeof manifestSchema>['contextCompiler'] & {
  readonly folder: string;
};

type Loaded = MonitorManifest & {
  readonly condition: Condition<Query, unknown>;
};

// Each registered monitor: the chat its instruction goes to, and its last
// run and failure as the page shows them.
const monitorTables = new Declaration(
  [
    'CREATE TABLE monitors (name TEXT PRIMARY KEY, thread TEXT NOT NULL, added_at TEXT NOT NULL, ran_at TEXT, failure TEXT, failed_at TEXT)',
    'CREATE TABLE monitor_keys (name TEXT NOT NULL REFERENCES monitors (name) ON DELETE CASCADE, key TEXT NOT NULL, PRIMARY KEY (name, key)) WITHOUT ROWID',
  ],
  { rows: 'replace' },
);

const now = () => new Date().toISOString();
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type MonitorState =
  | { readonly state: 'inactive' }
  | { readonly state: 'broken'; readonly error: string }
  | {
      readonly state: 'watching';
      readonly thread: string;
      readonly ranAt: string | null;
      readonly failure: string | null;
    };

export type MonitorStatus = {
  readonly name: string;
  readonly title: string;
  readonly description: string | null;
  readonly instruction: string | null;
} & MonitorState;

// The monitors in the folder the plugin reads, what each registered one
// last did, and the check that runs after each import: every registered
// monitor's condition over the imports, each new match sent to its chat as
// the monitor's instruction through `codex queue`.
export class Monitors {
  readonly #root: string;
  readonly #store: string;
  readonly #codex: string;

  constructor(options: {
    readonly root: string;
    readonly store: string;
    readonly codex: string;
  }) {
    this.#root = options.root;
    this.#store = options.store;
    this.#codex = options.codex;
  }

  // Registers a monitor for the chat it was added from. Its condition's
  // matches now are its baseline, so only what starts to match later is sent.
  async add(name: string, thread: string, locate: Locate): Promise<void> {
    const { loaded, broken } = await this.#load();
    const monitor = loaded.get(name);
    if (monitor === undefined)
      throw new Error(
        broken.get(name) ??
          `No monitor is named ${name}. Write it in ${this.#root} first.`,
      );
    using federation = new Federation({ main: ':memory:', locate });
    const eca = new Eca<Query, unknown>({ warehouse: once(federation.sql) });
    const rule = { condition: monitor.condition };
    await eca.add(rule);
    using store = this.#open();
    transaction(
      store,
      () => {
        store
          .prepare(
            'INSERT INTO monitors (name, thread, added_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET thread = excluded.thread, added_at = excluded.added_at, ran_at = NULL, failure = NULL, failed_at = NULL',
          )
          .run(name, thread, now());
        replaceKeys(store, name, eca.keys(rule));
      },
      { mode: 'immediate' },
    );
  }

  // Evaluates every registered monitor that loads, from the keys it saved.
  // Each new match is sent before its keys are saved, so a stop in between
  // sends it again and never loses it; a send that fails stops the check, and
  // that match comes again at the next one. What it writes afterwards goes to
  // the registration it read, so a monitor removed or added again meanwhile
  // keeps what that change wrote.
  async check(locate: () => Locate): Promise<void> {
    const { loaded } = await this.#load();
    using store = this.#open();
    const rules = new Map<
      Rule<Query, unknown>,
      Registered & { readonly monitor: Loaded }
    >();
    for (const registered of registeredMonitors(store)) {
      const monitor = loaded.get(registered.name);
      if (monitor !== undefined)
        rules.set({ condition: monitor.condition }, { ...registered, monitor });
    }
    if (rules.size === 0) return;
    let where: Locate;
    try {
      where = locate();
    } catch (error) {
      // No import can be found, as with settings that cannot be read: each
      // monitor says why, and the next import checks it again.
      for (const registered of rules.values())
        fail(store, registered, `Last check failed: ${messageOf(error)}`);
      return;
    }
    using federation = new Federation({ main: ':memory:', locate: where });
    const eca = new Eca<Query, unknown>({ warehouse: once(federation.sql) });
    for (const [rule, { name }] of rules)
      await eca.add(rule, { keys: savedKeys(store, name) });
    const failed = new Set<string>();
    // The warehouse commits once, so the watch ends after that evaluation.
    for await (const found of eca.watch({
      signal: new AbortController().signal,
    })) {
      const registered = rules.get(found.rule);
      if (registered === undefined) continue;
      if ('error' in found) {
        failed.add(registered.name);
        fail(store, registered, `Last check failed: ${messageOf(found.error)}`);
        continue;
      }
      try {
        await promisify(execFile)(this.#codex, [
          'queue',
          '--thread',
          registered.thread,
          '--message',
          `Monitor "${registered.monitor.title}" triggered: ${registered.monitor.instruction}`,
        ]);
      } catch (error) {
        failed.add(registered.name);
        fail(
          store,
          registered,
          `Could not send to its chat: ${reasonOf(error)}`,
        );
        break;
      }
      store
        .prepare(
          'UPDATE monitors SET ran_at = ? WHERE name = ? AND added_at = ?',
        )
        .run(now(), registered.name, registered.addedAt);
    }
    for (const [rule, registered] of rules) {
      transaction(
        store,
        () => {
          if (stillAdded(store, registered)) {
            replaceKeys(store, registered.name, eca.keys(rule));
            if (!failed.has(registered.name))
              store
                .prepare(
                  'UPDATE monitors SET failure = NULL, failed_at = NULL WHERE name = ?',
                )
                .run(registered.name);
          }
        },
        { mode: 'immediate' },
      );
    }
  }

  // Every monitor found or registered: one that loads and is registered
  // watches; one that loads and is not waits to be added from a chat.
  async status(): Promise<MonitorStatus[]> {
    const { loaded, broken } = await this.#load();
    using store = this.#open();
    const registered = new Map(
      registeredMonitors(store).map((item) => [item.name, item]),
    );
    const names = [
      ...new Set([...loaded.keys(), ...broken.keys(), ...registered.keys()]),
    ].sort();
    return names.map((name): MonitorStatus => {
      const monitor = loaded.get(name);
      const shown = {
        name,
        title: monitor?.title ?? name,
        description: monitor?.description ?? null,
        instruction: monitor?.instruction ?? null,
      };
      const error = broken.get(name);
      if (error !== undefined) return { ...shown, state: 'broken', error };
      if (monitor === undefined)
        return { ...shown, state: 'broken', error: 'Its folder is gone.' };
      const added = registered.get(name);
      if (added === undefined) return { ...shown, state: 'inactive' };
      return {
        ...shown,
        state: 'watching',
        thread: added.thread,
        ranAt: added.ranAt,
        failure: added.failure,
      };
    });
  }

  // Forgets a monitor and deletes its folder.
  async remove(name: string): Promise<void> {
    const { loaded } = await this.#load();
    {
      using store = this.#open();
      store.prepare('DELETE FROM monitors WHERE name = ?').run(name);
    }
    const folder = loaded.get(name)?.folder;
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  }

  #open(): DatabaseSync {
    mkdirSync(dirname(this.#store), { recursive: true });
    const store = new DatabaseSync(this.#store, { timeout: 30_000 });
    try {
      store.exec('PRAGMA foreign_keys = ON');
      monitorTables.apply(store);
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  // Each folder's monitor, or why it did not load. Node keeps a module it
  // loaded, so the entry's URL carries its modification time: an edited
  // monitor loads again.
  async #load(): Promise<{
    loaded: Map<string, Loaded>;
    broken: Map<string, string>;
  }> {
    const loaded = new Map<string, Loaded>();
    const broken = new Map<string, string>();
    if (existsSync(this.#root))
      for (const folder of readdirSync(this.#root).sort()) {
        const path = join(this.#root, folder);
        const manifestPath = join(path, 'package.json');
        if (!existsSync(manifestPath)) continue;
        let parsed: z.infer<typeof manifestSchema>;
        try {
          parsed = manifestSchema.parse(
            JSON.parse(readFileSync(manifestPath, 'utf8')),
          );
        } catch (error) {
          broken.set(folder, `Could not be loaded: ${messageOf(error)}`);
          continue;
        }
        const manifest = { ...parsed.contextCompiler, folder: path };
        try {
          const entry = pathToFileURL(join(path, parsed.exports));
          entry.searchParams.set('modified', String(statSync(entry).mtimeMs));
          const { default: exported }: { default?: unknown } = await import(
            entry.href
          );
          loaded.set(manifest.name, {
            ...manifest,
            condition: conditionOf(exported),
          });
        } catch (error) {
          broken.set(manifest.name, `Could not be loaded: ${messageOf(error)}`);
        }
      }
    return { loaded, broken };
  }
}

type Registered = {
  readonly name: string;
  readonly thread: string;
  readonly addedAt: string;
  readonly ranAt: string | null;
  readonly failure: string | null;
};

function registeredMonitors(store: DatabaseSync): Registered[] {
  return store
    .prepare(
      'SELECT name, thread, added_at, ran_at, failure FROM monitors ORDER BY name',
    )
    .all()
    .map((row) => ({
      name: String(row.name),
      thread: String(row.thread),
      addedAt: String(row.added_at),
      ranAt: row.ran_at === null ? null : String(row.ran_at),
      failure: row.failure === null ? null : String(row.failure),
    }));
}

function savedKeys(store: DatabaseSync, name: string): string[] {
  return store
    .prepare('SELECT key FROM monitor_keys WHERE name = ?')
    .all(name)
    .map((row) => String(row.key));
}

// Whether the registration a check read is still there: not removed, and not
// added again since.
function stillAdded(store: DatabaseSync, registered: Registered): boolean {
  return (
    store
      .prepare('SELECT 1 FROM monitors WHERE name = ? AND added_at = ?')
      .get(registered.name, registered.addedAt) !== undefined
  );
}

// Inside the caller's transaction.
function replaceKeys(
  store: DatabaseSync,
  name: string,
  keys: ReadonlySet<string>,
) {
  store.prepare('DELETE FROM monitor_keys WHERE name = ?').run(name);
  const insert = store.prepare(
    'INSERT INTO monitor_keys (name, key) VALUES (?, ?)',
  );
  for (const key of keys) insert.run(name, key);
}

function fail(store: DatabaseSync, registered: Registered, failure: string) {
  store
    .prepare(
      'UPDATE monitors SET failure = ?, failed_at = ? WHERE name = ? AND added_at = ?',
    )
    .run(failure, now(), registered.name, registered.addedAt);
}

// What codex said when it refused, rather than the command line Node puts
// before it.
function reasonOf(error: unknown): string {
  const said =
    typeof error === 'object' && error !== null && 'stderr' in error
      ? String(error.stderr).trim()
      : '';
  return said === '' ? messageOf(error) : said;
}

// The warehouse of one check: the imports as they are now, committed once.
function once(sql: Query) {
  return {
    sql,
    async *commits() {
      yield;
    },
  };
}

// A monitor module's default export: an object with evaluate(sql), as eca's
// Condition, whose matches are checked before eca reads them.
function conditionOf(exported: unknown): Condition<Query, unknown> {
  const evaluate: unknown =
    typeof exported === 'object' && exported !== null && 'evaluate' in exported
      ? exported.evaluate
      : undefined;
  if (typeof evaluate !== 'function')
    throw new TypeError(
      'Its entry does not export an object with evaluate(sql) by default.',
    );
  return {
    evaluate: async (sql) =>
      matchesSchema.parse(await Reflect.apply(evaluate, exported, [sql])),
  };
}
