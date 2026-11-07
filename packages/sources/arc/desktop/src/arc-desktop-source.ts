import { ClosedWorld } from '@zukhruf/snapshot-differential';

import {
  Catalog,
  type CopyConfiguration,
  type ExtractionCoverage,
  Source,
  type SourceMessage,
  type Stream,
  diffSnapshot,
} from '@workspace/elt';
import {
  ArcSidebar,
  type ArcSidebarContent,
  ArcSidebarUnavailableError,
} from '@workspace/sdk-arc-desktop';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import { SidebarItemsStream } from './streams/sidebar-items-stream.ts';
import { SpacesStream } from './streams/spaces-stream.ts';

const spacesReader = new SpacesStream();
const sidebarItemsReader = new SidebarItemsStream();
const readers = [spacesReader, sidebarItemsReader];
const catalog = new Catalog(readers.map((reader) => reader.describe()));

function readerOf(stream: Stream) {
  const reader = readers.find((reader) => reader.name === stream.name);
  if (reader === undefined)
    throw new TypeError(`Arc has no ${stream.name} stream`);
  return reader;
}

// How often a watch checks the file for a write.
const pollIntervalMs = 1000;

// One read of the sidebar file for a run, so items and the spaces they name
// come from one version of it.
class SidebarRead implements AsyncDisposable {
  readonly content: ArcSidebarContent;

  constructor(content: ArcSidebarContent) {
    this.content = content;
  }

  async [Symbol.asyncDispose]() {}
}

// Reads Arc's sidebar from the home folder `home`: the spaces, and the tabs,
// folders, notes and split views in them and in each profile's favorites.
// Arc's history is in its Chromium profiles, which source-chromium-browser
// reads.
export class ArcDesktopSource extends Source<SidebarRead> {
  readonly identity = 'arc-desktop';
  protected readonly catalog = catalog;
  readonly spaces = catalog.get(spacesReader.name);
  readonly sidebarItems = catalog.get(sidebarItemsReader.name);
  readonly scope: ImportScope;
  readonly #sidebar: ArcSidebar;

  constructor({ home, scope = {} }: { home: string; scope?: ImportScope }) {
    super();
    this.scope = scope;
    this.#sidebar = new ArcSidebar(home);
    Object.freeze(this);
  }

  protected override async open(): Promise<SidebarRead> {
    return new SidebarRead(await this.#sidebar.read());
  }

  protected override readonly configErrors = [ArcSidebarUnavailableError];

  override coverage(): ExtractionCoverage {
    return {
      description:
        'Every space and item that Arc’s sidebar holds now, of the selected profiles. An item the user removed from the sidebar is deleted. Dates do not narrow the sidebar.',
      selection:
        this.scope.collectionIds === undefined
          ? {}
          : { collectionIds: this.scope.collectionIds },
    };
  }

  // Arc writes the file only while it runs, so the sidebar is current as of
  // its last write.
  override currentAsOf(): Promise<Date> {
    return this.#sidebar.lastWrite();
  }

  // One file, so a write wakes every stream; the snapshot diff writes
  // nothing when no record changed.
  override changeSignals(streams: readonly Stream[]) {
    return [
      {
        gauge: this.#sidebar.version(),
        streams,
        interval: pollIntervalMs,
        // A local read: a check that takes the whole interval is stuck.
        timeout: pollIntervalMs,
      },
    ];
  }

  // The file is the whole sidebar now, so an item that left it was removed.
  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    _partition: null,
    read: SidebarRead,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const records: readonly Record<string, unknown>[] = readerOf(
      configuration.stream,
    ).records(read.content, this.scope);
    yield* diffSnapshot(configuration, records, state, {
      policy: new ClosedWorld(),
      signal,
    });
  }
}
