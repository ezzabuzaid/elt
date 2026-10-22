import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  type IndexedDBDatabase,
  IndexedDBFormatError,
  readIndexedDB,
} from '@workspace/codec-chromium-indexeddb';

import { TeamsFormatError, TeamsUnavailableError } from './errors.ts';
import { Fields } from './fields.ts';
import { readTeamsClient } from './teams-client-reader.ts';
import type { TeamsAccount, TeamsClient } from './teams-client.ts';

// New Teams runs its web client in Edge WebView2 inside its App Store
// container; work and school accounts share the WebView profile tfw, whose
// web client keeps its caches in the IndexedDB of teams.microsoft.com.
const profile =
  'Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams/EBWebView/WV2Profile_tfw';
const indexedDB = 'IndexedDB/https_teams.microsoft.com_0.indexeddb.leveldb';
// Each manager of the web client keeps its own database per account and
// language, Teams:<manager>:react-web-client:<ids>:<locale>, where <ids> is
// mostly <tenant>:<user>, for some managers <tenant>:8:orgid:<user>, and for
// a few <user>:<tenant>. The conversation manager's names the account.
const databaseName = /^Teams:([^:]+):react-web-client:(.+):([^:]+)$/;
const objectId =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
// LevelDB compacts its files into new ones and deletes the old while Teams
// runs; a read that loses that race reads again.
const attempts = 3;
// What the file system answers for a store that is missing, or that macOS
// keeps from a process without Full Disk Access.
const unreadable = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);

export function teamsDirectory(): string {
  return join(homedir(), profile);
}

export class TeamsStore {
  readonly #directory: string;

  constructor(directory = teamsDirectory()) {
    this.#directory = directory;
  }

  // Every account signed in to the app, as its web client last saved it.
  async clients(): Promise<TeamsClient[]> {
    const databases = await this.#read();
    return accounts(databases).map(({ account, managers }) =>
      readTeamsClient(account, managers),
    );
  }

  // A value that changes whenever the web client writes its caches.
  version(): string {
    return this.#saved()
      .map(({ name, stats }) => `${name}:${stats?.size}:${stats?.mtimeMs}`)
      .join('\n');
  }

  // When the web client last wrote its caches. It writes them only while
  // the app runs, so a closed app's store stays as of then.
  lastWrite(): Date {
    return new Date(
      Math.max(...this.#saved().flatMap(({ stats }) => stats?.mtimeMs ?? [])),
    );
  }

  // The files of the web client's database. A file LevelDB removed after the
  // folder was listed has no stats. CURRENT always has: LevelDB replaces it
  // by a rename, never removes it.
  #saved() {
    const directory = join(this.#directory, indexedDB);
    try {
      return readdirSync(directory)
        .sort()
        .map((name) => ({
          name,
          stats: statSync(join(directory, name), { throwIfNoEntry: false }),
        }));
    } catch (error) {
      throw new TeamsUnavailableError(this.#directory, error);
    }
  }

  async #read(): Promise<IndexedDBDatabase[]> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await readIndexedDB(join(this.#directory, indexedDB));
      } catch (error) {
        if (error instanceof IndexedDBFormatError)
          throw new TeamsFormatError('IndexedDB', error.message, error);
        const code = errorCode(error);
        if (code === 'ENOENT' && attempt < attempts && this.#exists()) continue;
        if (typeof code === 'string' && unreadable.has(code))
          throw new TeamsUnavailableError(this.#directory, error);
        throw error;
      }
    }
  }

  #exists(): boolean {
    try {
      return statSync(join(this.#directory, indexedDB)).isDirectory();
    } catch {
      return false;
    }
  }
}

type Account = {
  readonly account: TeamsAccount;
  readonly managers: ReadonlyMap<string, IndexedDBDatabase>;
};

// When Teams' language changes, its web client starts a new set of databases
// for each account and leaves the old set behind, so an account reads the set
// it synced last.
function accounts(databases: readonly IndexedDBDatabase[]): Account[] {
  const named = databases.flatMap((database) => {
    const parts = databaseName.exec(database.name);
    if (parts === null) return [];
    const [, manager = '', ids = '', locale = ''] = parts;
    return [
      {
        database,
        manager,
        locale,
        ids: [...ids.matchAll(objectId)].map(String),
      },
    ];
  });
  const live = new Map<string, Account>();
  for (const { database, manager, locale, ids } of named) {
    if (manager !== 'conversation-manager') continue;
    const [tenantId, userId] = ids;
    if (tenantId === undefined || userId === undefined)
      throw new TeamsFormatError(database.name, 'it names no tenant and user');
    const managers = new Map(
      named
        .filter(
          (other) =>
            other.locale === locale &&
            other.ids.length === 2 &&
            other.ids.includes(tenantId) &&
            other.ids.includes(userId),
        )
        .map(({ manager, database }) => [manager, database]),
    );
    const other = live.get(`${tenantId}:${userId}`);
    if (
      other !== undefined &&
      lastSynced(other.managers) >= lastSynced(managers)
    )
      continue;
    live.set(`${tenantId}:${userId}`, {
      account: {
        userId,
        tenantId,
        mri: `8:orgid:${userId}`,
        tenantDomains: tenantDomains(managers.get('tenant-manager')),
      },
      managers,
    });
  }
  return [...live.values()];
}

// When the client last synced any conversation of this set.
function lastSynced(managers: ReadonlyMap<string, IndexedDBDatabase>): number {
  const database = managers.get('syncstate-manager');
  const states = database?.objectStores.find(
    ({ name }) => name === 'syncstates',
  );
  return Math.max(
    Number.NEGATIVE_INFINITY,
    ...(states?.records ?? []).map(
      ({ key, value }) =>
        new Fields(
          value,
          `${database?.name}/syncstates`,
          JSON.stringify(key),
        ).number('lastSyncTime') ?? Number.NEGATIVE_INFINITY,
    ),
  );
}

function tenantDomains(database: IndexedDBDatabase | undefined): string[] {
  const record = database?.objectStores
    .find(({ name }) => name === 'tenant')
    ?.records.find(({ key }) => key === 'domains');
  return record === undefined
    ? []
    : new Fields(record.value, `${database?.name}/tenant`, 'domains').strings(
        'value',
      );
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}
