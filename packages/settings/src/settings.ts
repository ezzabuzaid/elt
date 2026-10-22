import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Declaration } from '@zukhruf/sqlite-drift';
import { transaction } from '@zukhruf/sqlite-transaction';

import type { FailureType } from '@workspace/elt';
import {
  installSQLiteCatalog,
  publishSQLiteViews,
} from '@workspace/elt-sqlite';

import {
  type ConnectorFacts,
  type Selection,
  selectionProblems,
} from './selection.ts';

// How long a connection waits out another process writing the settings.
const writerWaitMs = 30_000;

// How often an import that is running checks that the user still selects it,
// as Airbyte's worker sends a heartbeat to learn its sync was cancelled.
const heartbeatMs = 1_000;

// Tables another version declared otherwise are replaced, and the selection
// they held is lost: stored settings are disposable, so the user sets up again.
// A selection and a failure name their import by its folder relative to the
// root, so a store moved to another folder still names its imports.
const settingsTables = new Declaration(
  [
    'CREATE TABLE selections (position INTEGER PRIMARY KEY, connector TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, include_attachments INTEGER NOT NULL, directory TEXT NOT NULL, permissions TEXT NOT NULL)',
    "CREATE TABLE connection_failures (directory TEXT PRIMARY KEY, error TEXT NOT NULL, failure_type TEXT NOT NULL CHECK (failure_type IN ('config', 'system')), failed_at TEXT NOT NULL)",
    'CREATE TABLE transcription (id INTEGER PRIMARY KEY CHECK (id = 1), model TEXT NOT NULL)',
  ],
  { rows: 'replace' },
);

// Where a connector's import lives: one directory per selection, so a pass
// still writing an earlier selection never touches the current one.
export function importDirectory(root: string, selection: Selection): string {
  return join(root, importFolder(selection));
}

function importFolder(selection: Selection): string {
  const key = createHash('sha256')
    .update(JSON.stringify([selection.scope, selection.includeAttachments]))
    .digest('hex')
    .slice(0, 16);
  return join(selection.connector, key);
}

// Why a connector's import failed in a way its sync history in data.sqlite
// cannot record, and whose that is to fix: the import never connected, or the
// history itself could not install or record.
type ConnectionFailure = {
  error: string;
  failedAt: string;
  failureType: FailureType;
};

// The reason a running import stops when the user removes its connector.
export class ConnectorRemovedError extends Error {
  override name = 'ConnectorRemovedError';

  constructor(connector: string) {
    super(`${connector} was removed from the selection`);
  }
}

// What readers of the settings file see: one row per selected connector, with
// where its import lives and why it last failed in a way its history cannot record.
const selectedConnectors = {
  name: 'selected_connectors',
  description:
    'The connectors the user chose to import, in the order chosen. A connector missing here is not imported. Each import is its own SQLite file: open database to read its records, catalog and sync_status.',
  columns: {
    connector: 'Connector name, such as mail, notes or messages.',
    scope:
      'JSON of the chosen accounts (accountIds), collections (collectionIds) and dates (startAt inclusive, endAt exclusive); an absent key means all.',
    include_attachments:
      '1 when attachment bytes are copied beside the records, 0 for metadata only.',
    database:
      'Path of the SQLite file the import loads, relative to the folder that holds this settings file. It may not exist yet while the first import starts.',
    connection_error:
      'Why the import last failed in a way sync_status cannot record, such as missing macOS access or a database it could not write; NULL when sync_status has the outcome. A connector with an error is inaccessible, not empty.',
    connection_failure_type:
      'config when the user can fix connection_error by giving access or changing what they set up, and permissions says how; system for any other reason; NULL when sync_status has the outcome.',
    connection_failed_at:
      'When the import last failed in a way sync_status cannot record, as an ISO 8601 UTC timestamp; NULL when sync_status has the outcome.',
    permissions: 'What the user can do in macOS to give access to this app.',
  },
  query: `SELECT s."connector", s."scope", s."include_attachments", s."directory" || '/data.sqlite' AS "database",
      f."error" AS "connection_error", f."failure_type" AS "connection_failure_type", f."failed_at" AS "connection_failed_at", s."permissions"
    FROM "selections" s LEFT JOIN "connection_failures" f ON f."directory" = s."directory"
    ORDER BY s."position"`,
};

// One host's settings under root: settings.sqlite holds the selection and each
// import's connection failure, and readers find the imports through its
// selected_connectors view; each import lives in its own directory beside it.
export class Settings implements Disposable {
  readonly root: string;
  private readonly settings: DatabaseSync;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const path = this.#path;
    this.settings = new DatabaseSync(path, { timeout: writerWaitMs });
    try {
      chmodSync(path, 0o600);
      const built = settingsTables.drift(this.settings) !== 'fits';
      settingsTables.apply(this.settings);
      // Readers find selected_connectors before anything is selected.
      if (built) this.#publish();
    } catch (error) {
      this.settings.close();
      throw error;
    }
  }

  get #path(): string {
    return join(this.root, 'settings.sqlite');
  }

  selections(): Selection[] {
    return this.settings
      .prepare(
        'SELECT connector, scope, include_attachments FROM selections ORDER BY position',
      )
      .all()
      .map((row) => ({
        connector: String(row.connector),
        scope: JSON.parse(String(row.scope)),
        includeAttachments: row.include_attachments === 1,
      }));
  }

  // The transcription model the user chose, by the id Handy installs it under:
  // the hosts find its files on whichever Mac reads the store.
  transcription(): string | null {
    const row = this.settings
      .prepare('SELECT model FROM transcription WHERE id = 1')
      .get();
    if (row === undefined) return null;
    if (typeof row.model !== 'string')
      throw new TypeError('Invalid stored transcription model');
    return row.model;
  }

  setTranscription(model: string | null): void {
    if (model === null) this.settings.exec('DELETE FROM transcription');
    else
      this.settings
        .prepare(
          'INSERT INTO transcription VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET model = excluded.model',
        )
        .run(model);
  }

  // Saves a selection that has no problems, with what macOS needs granted for
  // each connector, forgets the failures of every other import and publishes
  // what readers see. The imports it no longer names are left stale.
  select<Selected extends Selection>(
    selections: readonly Selected[],
    {
      facts,
      permissions,
    }: {
      facts: (connector: string) => ConnectorFacts;
      permissions: (selection: Selected) => string;
    },
  ): void {
    const problems = selectionProblems(selections, facts);
    if (problems.length > 0) throw new Error(problems.join('\n'));
    transaction(
      this.settings,
      () => {
        this.settings.exec('DELETE FROM selections');
        const insert = this.settings.prepare(
          'INSERT INTO selections VALUES(?,?,?,?,?,?)',
        );
        for (const [position, selection] of selections.entries())
          insert.run(
            position,
            selection.connector,
            JSON.stringify(selection.scope),
            selection.includeAttachments ? 1 : 0,
            importFolder(selection),
            permissions(selection),
          );
        this.settings.exec(
          'DELETE FROM connection_failures WHERE directory NOT IN (SELECT directory FROM selections)',
        );
      },
      { mode: 'immediate' },
    );
    this.#publish();
  }

  // Every import directory but the selected one of each connector, including
  // those of connectors no longer selected. A host removes each once no pass
  // runs it, since a pass keeps its locks inside.
  staleImports(): string[] {
    const kept = new Set(
      this.selections().map((selection) => this.directory(selection)),
    );
    return readdirSync(this.root, { withFileTypes: true })
      .filter((connector) => connector.isDirectory())
      .flatMap((connector) =>
        readdirSync(join(this.root, connector.name)).map((entry) =>
          join(this.root, connector.name, entry),
        ),
      )
      .filter((directory) => !kept.has(directory));
  }

  // Aborts with ConnectorRemovedError once the selection no longer names this
  // import. It reads the settings again only when PRAGMA data_version says
  // another connection committed.
  removal(selection: Selection): Disposable & { readonly signal: AbortSignal } {
    const folder = importFolder(selection);
    const watcher = new DatabaseSync(this.#path, {
      readOnly: true,
      timeout: writerWaitMs,
    });
    const version = watcher.prepare('PRAGMA data_version');
    const selected = watcher.prepare(
      'SELECT 1 FROM selections WHERE directory = ?',
    );
    const controller = new AbortController();
    let seen: unknown;
    // A timer's error would end the process; the import stops with it instead.
    const check = () => {
      try {
        const current = version.get()?.data_version;
        if (current === seen) return;
        seen = current;
        if (selected.get(folder) === undefined)
          controller.abort(new ConnectorRemovedError(selection.connector));
      } catch (error) {
        controller.abort(error);
      }
    };
    check();
    const heartbeat = setInterval(check, heartbeatMs);
    const stop = () => {
      clearInterval(heartbeat);
      if (watcher.isOpen) watcher.close();
    };
    controller.signal.addEventListener('abort', stop, { once: true });
    return { signal: controller.signal, [Symbol.dispose]: stop };
  }

  // Publishes selected_connectors and the catalog listing it; safe to repeat.
  #publish() {
    publishSQLiteViews(this.settings, { views: [selectedConnectors] });
    installSQLiteCatalog({ path: this.#path });
  }

  directory(selection: Selection): string {
    return importDirectory(this.root, selection);
  }

  database(selection: Selection): string {
    return join(this.directory(selection), 'data.sqlite');
  }

  connectionFailure(selection: Selection): ConnectionFailure | undefined {
    const row = this.settings
      .prepare(
        'SELECT error, failure_type, failed_at FROM connection_failures WHERE directory=?',
      )
      .get(importFolder(selection));
    return row === undefined
      ? undefined
      : {
          error: String(row.error),
          failedAt: String(row.failed_at),
          failureType: row.failure_type === 'config' ? 'config' : 'system',
        };
  }

  saveConnectionFailure(
    selection: Selection,
    error: string,
    failureType: FailureType,
  ) {
    this.settings
      .prepare(
        "INSERT INTO connection_failures (directory, error, failure_type, failed_at) VALUES(?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(directory) DO UPDATE SET error=excluded.error, failure_type=excluded.failure_type, failed_at=excluded.failed_at",
      )
      .run(importFolder(selection), error, failureType);
  }

  clearConnectionFailure(selection: Selection) {
    this.settings
      .prepare('DELETE FROM connection_failures WHERE directory=?')
      .run(importFolder(selection));
  }

  [Symbol.dispose]() {
    this.settings.close();
  }
}
