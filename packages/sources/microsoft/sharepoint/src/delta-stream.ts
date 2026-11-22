import type { CopyConfiguration, KeyValue, SourceMessage } from '@eltjs/elt';
import {
  DeltaExpiredError,
  type DeltaPage,
} from '@eltjs/sdk-microsoft-sharepoint';

import type { ScopeFolder } from './folder-scope.ts';
import type { SharePointRun } from './sharepoint-run.ts';
import { SharePointStream } from './sharepoint-stream.ts';

// Where the delta query of one collection stands: the delta link of its last
// page once a read reached it, or the next link of the page a read reached
// before it.
export type Link = { readonly delta: string } | { readonly next: string };

// Where the first read of the scope folders of a drive stands: the delta link
// that the read took before it listed them, the folders it has still to list,
// the first being the one it lists now, and the next link of the children of
// that folder after the pages it read, or null to list it from the start.
export type Walk = {
  readonly delta: string;
  readonly folders: readonly [string, ...string[]];
  readonly next: string | null;
};

// A site limited to folders: its scope folders, as driveId/itemId, each item
// under them, by drive, with the folder that holds it, and the walk of each
// drive whose first read has not ended. A drive has a walk or a link, never
// both.
export type FolderState = {
  readonly folders: readonly string[];
  readonly items: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly walks: Readonly<Record<string, Walk>>;
};

// Where a site stands: the link of each collection, a drive or a list, by its
// ID, the fields the reads carried, and the scope of a site that the host
// limited to folders.
export type DeltaState = {
  readonly fields: readonly string[];
  readonly links: Readonly<Record<string, Link>>;
  readonly scope?: FolderState;
};

type Read = (links: ReadonlyMap<string, Link>) => AsyncGenerator<SourceMessage>;

function link(value: unknown): Link | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if ('delta' in value && typeof value.delta === 'string')
    return { delta: value.delta };
  if ('next' in value && typeof value.next === 'string')
    return { next: value.next };
  return undefined;
}

export function resumeLink(saved: Link | undefined): string | undefined {
  if (saved === undefined) return undefined;
  return 'delta' in saved ? saved.delta : saved.next;
}

function texts(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((it) => typeof it === 'string');
}

function walk(value: unknown): Walk | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('delta' in value) ||
    typeof value.delta !== 'string' ||
    !('folders' in value) ||
    !texts(value.folders) ||
    !('next' in value) ||
    (value.next !== null && typeof value.next !== 'string')
  )
    return undefined;
  const [first, ...rest] = value.folders;
  if (first === undefined) return undefined;
  return { delta: value.delta, folders: [first, ...rest], next: value.next };
}

function folderState(value: unknown): FolderState | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('folders' in value) ||
    !texts(value.folders) ||
    !('items' in value) ||
    typeof value.items !== 'object' ||
    value.items === null ||
    !('walks' in value) ||
    typeof value.walks !== 'object' ||
    value.walks === null
  )
    return undefined;
  const items: Record<string, Record<string, string>> = {};
  for (const [drive, parents] of Object.entries(value.items)) {
    if (typeof parents !== 'object' || parents === null) return undefined;
    const byItem: Record<string, string> = {};
    for (const [item, parent] of Object.entries(parents)) {
      if (typeof parent !== 'string') return undefined;
      byItem[item] = parent;
    }
    items[drive] = byItem;
  }
  const walks: Record<string, Walk> = {};
  for (const [drive, saved] of Object.entries(value.walks)) {
    const parsed = walk(saved);
    if (parsed === undefined) return undefined;
    walks[drive] = parsed;
  }
  return { folders: value.folders, items, walks };
}

function parse(state: unknown): DeltaState | null {
  if (state === null) return null;
  const unknown = () =>
    new TypeError(`Unknown SharePoint delta state ${JSON.stringify(state)}`);
  if (
    typeof state !== 'object' ||
    !('fields' in state) ||
    !texts(state.fields) ||
    !('links' in state) ||
    typeof state.links !== 'object' ||
    state.links === null
  )
    throw unknown();
  const links: Record<string, Link> = {};
  for (const [collection, value] of Object.entries(state.links)) {
    const parsed = link(value);
    if (parsed === undefined) throw unknown();
    links[collection] = parsed;
  }
  if (!('scope' in state)) return { fields: state.fields, links };
  const scope = folderState(state.scope);
  if (scope === undefined) throw unknown();
  return { fields: state.fields, links, scope };
}

/**
 * A stream read through the delta queries of Graph, one for each collection
 * of the site (ADR 0001). The first read loads every item, page by page, with
 * a checkpoint after each page, so a first load that fails resumes at the
 * next link it saved. Later reads apply the changes after each delta link:
 * an item with the deleted facet is a deletion. When Graph no longer serves
 * a link, when a collection of the state is gone, when the stream carries a
 * field that the state was read without, or when the site was read with
 * scope folders, the stream starts the site over with a RESET and loads every
 * item again. A site that the host limited to folders loads nothing of a
 * restricted stream, and the scoped read of the others (ADR 0003).
 */
export abstract class DeltaStream<Item> extends SharePointStream {
  // The IDs of the collections of the site that this stream reads.
  protected abstract collections(
    siteUrl: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): Promise<readonly string[]>;

  // The pages of the delta query of one collection, from link, or from the
  // start without one.
  protected abstract pages(
    siteUrl: string,
    collection: string,
    link: string | undefined,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncIterable<DeltaPage<Item>>;

  // The messages of one item of a page: its record, its deletion, or none.
  protected abstract messages(
    configuration: CopyConfiguration,
    siteUrl: string,
    collection: string,
    item: Item,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncIterable<SourceMessage>;

  async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    siteUrl: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<SourceMessage> {
    const saved =
      configuration.syncMode === 'incremental' ? parse(state) : null;
    const scope = await run.scope(siteUrl, signal);
    if (scope !== 'site') {
      yield* this.restricted
        ? this.#nothing(saved)
        : this.scoped(configuration, saved, siteUrl, scope, run, signal);
      return;
    }
    const collections = await this.collections(siteUrl, run, signal);
    const read: Read = (links) =>
      this.#read(configuration, siteUrl, collections, links, run, signal);
    if (saved === null) {
      yield* read(new Map());
      return;
    }
    const links = new Map(Object.entries(saved.links));
    if (
      saved.scope !== undefined ||
      this.gained(saved.fields) ||
      links.keys().some((collection) => !collections.includes(collection))
    ) {
      yield* this.#reload(read);
      return;
    }
    try {
      yield* read(links);
    } catch (error) {
      if (!(error instanceof DeltaExpiredError)) throw error;
      yield* this.#reload(read);
    }
  }

  // The read of a site that the host limited to folders, by a stream that
  // is not restricted. saved is the state of the last read, whole or scoped.
  protected scoped(
    _configuration: CopyConfiguration,
    _saved: DeltaState | null,
    _siteUrl: string,
    _folders: readonly ScopeFolder[],
    _run: SharePointRun,
    _signal: AbortSignal,
  ): AsyncGenerator<SourceMessage> {
    throw new TypeError(
      `SharePoint ${this.stream.name} has no read for a site limited to folders`,
    );
  }

  // A DELETE in an incremental read; a full refresh replaces every row, so
  // it deletes nothing.
  protected *deletion(
    configuration: CopyConfiguration,
    key: Readonly<Record<string, KeyValue>>,
  ): Generator<SourceMessage> {
    if (configuration.syncMode === 'incremental')
      yield { type: 'DELETE', stream: this.stream.name, key };
  }

  // A RESET of a partition replaces its rows at the next commit (elt README,
  // "Reset"), so readers see the site fill again page by page, and a reload
  // that fails resumes at the last link it saved. A hidden reload of a
  // partition, as of a whole stream (elt ADR 0007), is backlog #4572.
  protected *reset(): Generator<SourceMessage> {
    yield { type: 'RESET', stream: this.stream.name };
  }

  protected state(
    links: ReadonlyMap<string, Link>,
    scope?: FolderState,
  ): SourceMessage {
    const site = { fields: this.#fields, links: Object.fromEntries(links) };
    return {
      type: 'STATE',
      stream: this.stream.name,
      state: scope === undefined ? site : { ...site, scope },
    };
  }

  // Whether the stream carries a field that a state was read without.
  protected gained(read: readonly string[]): boolean {
    return this.#fields.some((field) => !read.includes(field));
  }

  // A restricted stream loads nothing for a site limited to folders. A RESET
  // empties what an earlier read of the whole site loaded.
  *#nothing(saved: DeltaState | null): Generator<SourceMessage> {
    if (saved !== null && saved.scope === undefined) yield* this.reset();
    yield this.state(new Map(), { folders: [], items: {}, walks: {} });
  }

  async *#reload(read: Read): AsyncGenerator<SourceMessage> {
    yield* this.reset();
    yield* read(new Map());
  }

  async *#read(
    configuration: CopyConfiguration,
    siteUrl: string,
    collections: readonly string[],
    from: ReadonlyMap<string, Link>,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<SourceMessage> {
    const links = new Map(from);
    for (const collection of collections) {
      const start = resumeLink(links.get(collection));
      for await (const page of this.pages(
        siteUrl,
        collection,
        start,
        run,
        signal,
      )) {
        for (const item of page.items)
          yield* this.messages(
            configuration,
            siteUrl,
            collection,
            item,
            run,
            signal,
          );
        links.set(
          collection,
          'deltaLink' in page
            ? { delta: page.deltaLink }
            : { next: page.nextLink },
        );
        yield this.state(links);
      }
    }
  }

  // The fields a read carries. The state records them, since a delta gives
  // only the items that changed, and a field added later would reach only
  // them: elt keeps a stream's checkpoint and rows through a change of its
  // fields, and leaves filling them in to the source.
  get #fields(): readonly string[] {
    return Object.keys(this.stream.jsonSchema.properties ?? {});
  }
}
