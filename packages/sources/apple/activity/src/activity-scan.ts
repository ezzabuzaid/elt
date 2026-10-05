import { readdir } from 'node:fs/promises';

import {
  ActivityDatabase,
  type ActivityLocation,
  ActivityUnavailableError,
  biomeDevices,
  biomeStreams,
} from './activity-store.ts';

// Where macOS keeps each kind of activity: Biome's stream folders, the
// knowledgeC database, and Biome's list of synced devices.
export type ActivityStore = 'biome' | 'knowledge' | 'devices';

// The columns the streams read; opening a database checks them all.
const knowledgeColumns = {
  ZOBJECT: [
    'Z_PK',
    'ZUUID',
    'ZSTREAMNAME',
    'ZSTARTDATE',
    'ZENDDATE',
    'ZCREATIONDATE',
    'ZSECONDSFROMGMT',
    'ZVALUESTRING',
    'ZVALUEINTEGER',
    'ZSTRUCTUREDMETADATA',
    'ZSOURCE',
  ],
  ZSTRUCTUREDMETADATA: [
    'Z_PK',
    'Z_DKINTENTMETADATAKEY__INTENTCLASS',
    'Z_DKINTENTMETADATAKEY__INTENTVERB',
    'Z_DKINTENTMETADATAKEY__INTENTTYPE',
    'Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS',
    'Z_DKINTENTMETADATAKEY__DIRECTION',
    'Z_DKINTENTMETADATAKEY__DONATEDBYSIRI',
    'Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER',
    'Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER',
    'Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS',
    'Z_DKINTENTMETADATAKEY__SERIALIZEDINTERACTION',
    'Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__OSBUILD',
    'Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__USERINFO',
  ],
  ZSOURCE: ['Z_PK', 'ZBUNDLEID', 'ZDEVICEID', 'ZITEMID', 'ZGROUPID'],
} as const;

const deviceColumns = {
  DevicePeer: [
    'device_identifier',
    'me',
    'name',
    'model',
    'platform',
    'last_sync_date',
  ],
} as const;

type Opened = {
  biome: string;
  knowledge: ActivityDatabase;
  devices: ActivityDatabase;
};

// A store's contents, or why it could not be opened.
type Result<T> = { readonly value: T } | { readonly error: unknown };
type OpenedStores = { [S in ActivityStore]?: Result<Opened[S]> };

// One run's read of the activity stores the selected streams need: each
// database pinned to one read transaction, and the moment the run started,
// which every stream's expiry horizon counts back from. A store that cannot be
// opened fails only the streams that read it.
export class ActivityScan implements AsyncDisposable {
  readonly startedAt: Date;
  readonly #resources: AsyncDisposableStack;
  readonly #stores: OpenedStores;

  private constructor(
    startedAt: Date,
    resources: AsyncDisposableStack,
    stores: OpenedStores,
  ) {
    this.startedAt = startedAt;
    this.#resources = resources;
    this.#stores = stores;
  }

  static async open(
    location: ActivityLocation,
    stores: ReadonlySet<ActivityStore>,
  ): Promise<ActivityScan> {
    const startedAt = new Date();
    await using resources = new AsyncDisposableStack();
    const open = async <S extends ActivityStore>(
      store: S,
      value: () => Promise<Opened[S]>,
    ): Promise<Result<Opened[S]> | undefined> => {
      if (!stores.has(store)) return undefined;
      try {
        return { value: await value() };
      } catch (error) {
        return { error };
      }
    };
    const opened: OpenedStores = {
      // Each stream lists its own segments; this proves the folder is readable.
      biome: await open('biome', async () => {
        const root = biomeStreams(location);
        try {
          await readdir(root);
        } catch (cause) {
          throw new ActivityUnavailableError(root, cause);
        }
        return root;
      }),
      knowledge: await open('knowledge', async () =>
        resources.use(
          await ActivityDatabase.open(location.knowledge, knowledgeColumns),
        ),
      ),
      devices: await open('devices', async () =>
        resources.use(
          await ActivityDatabase.open(biomeDevices(location), deviceColumns),
        ),
      ),
    };
    return new ActivityScan(startedAt, resources.move(), opened);
  }

  // The folder holding every Biome stream.
  get biome(): string {
    return this.#value('biome');
  }

  get knowledge(): ActivityDatabase {
    return this.#value('knowledge');
  }

  get devices(): ActivityDatabase {
    return this.#value('devices');
  }

  #value<S extends ActivityStore>(store: S): Opened[S] {
    const opened: Result<Opened[S]> | undefined = this.#stores[store];
    if (opened === undefined)
      throw new Error(`Activity ${store} was not opened for this run`);
    if ('error' in opened) throw opened.error;
    return opened.value;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.#resources.disposeAsync();
  }
}
