import {
  BiomeStore,
  type BiomeStreams,
  type BiomeSync,
} from '@workspace/sdk-apple-biome';
import {
  type KnowledgeSnapshot,
  KnowledgeStore,
} from '@workspace/sdk-apple-knowledge';

// Where macOS keeps activity: the Biome folder, with its streams and device
// list, and the knowledgeC database.
export type ActivityLocation = {
  readonly biome: string;
  readonly knowledge: string;
};

// The store each stream reads: Biome's stream folders, knowledgeC, or
// Biome's device list.
type ActivityStore = 'biome' | 'knowledge' | 'devices';

type Opened = {
  biome: BiomeStreams;
  knowledge: KnowledgeSnapshot;
  devices: BiomeSync;
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
      value: () => Promise<Opened[S]> | Opened[S],
    ): Promise<Result<Opened[S]> | undefined> => {
      if (!stores.has(store)) return undefined;
      try {
        return { value: await value() };
      } catch (error) {
        return { error };
      }
    };
    const biome = new BiomeStore(location.biome);
    const opened: OpenedStores = {
      biome: await open('biome', () => biome.streams()),
      knowledge: await open('knowledge', () =>
        resources.use(new KnowledgeStore(location.knowledge).open()),
      ),
      devices: await open('devices', () => resources.use(biome.sync())),
    };
    return new ActivityScan(startedAt, resources.move(), opened);
  }

  get biome(): BiomeStreams {
    return this.#value('biome');
  }

  get knowledge(): KnowledgeSnapshot {
    return this.#value('knowledge');
  }

  get devices(): BiomeSync {
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
