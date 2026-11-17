import type { CopyConfiguration, KeyValue, SourceMessage } from '@eltjs/elt';
import {
  DeltaExpiredError,
  type DeltaPage,
} from '@eltjs/sdk-microsoft-sharepoint';

import type { SharePointRun } from './sharepoint-run.ts';
import { SharePointStream } from './sharepoint-stream.ts';

// Where the delta query of one collection stands: the delta link of its last
// page once a read reached it, or the next link of the page a read reached
// before it.
type Link = { readonly delta: string } | { readonly next: string };

// Where a site stands: the link of each collection, a drive or a list, by its
// ID, and the fields the reads carried.
type DeltaState = {
  readonly fields: readonly string[];
  readonly links: Readonly<Record<string, Link>>;
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

function resumeLink(saved: Link | undefined): string | undefined {
  if (saved === undefined) return undefined;
  return 'delta' in saved ? saved.delta : saved.next;
}

function parse(state: unknown): DeltaState | null {
  if (state === null) return null;
  const unknown = () =>
    new TypeError(`Unknown SharePoint delta state ${JSON.stringify(state)}`);
  if (
    typeof state !== 'object' ||
    !('fields' in state) ||
    !Array.isArray(state.fields) ||
    !state.fields.every((field) => typeof field === 'string') ||
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
  return { fields: state.fields, links };
}

/**
 * A stream read through the delta queries of Graph, one for each collection
 * of the site (ADR 0001). The first read loads every item, page by page, with
 * a checkpoint after each page, so a first load that fails resumes at the
 * next link it saved. Later reads apply the changes after each delta link:
 * an item with the deleted facet is a deletion. When Graph no longer serves
 * a link, when a collection of the state is gone, or when the stream carries
 * a field that the state was read without, the stream starts the site over
 * with a RESET and loads every item again.
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
    const collections = await this.collections(siteUrl, run, signal);
    const read: Read = (links) =>
      this.#read(configuration, siteUrl, collections, links, run, signal);
    const saved =
      configuration.syncMode === 'incremental' ? parse(state) : null;
    if (saved === null) {
      yield* read(new Map());
      return;
    }
    const links = new Map(Object.entries(saved.links));
    if (
      this.#gained(saved.fields) ||
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
  async *#reload(read: Read): AsyncGenerator<SourceMessage> {
    yield { type: 'RESET', stream: this.stream.name };
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
    const state = (): SourceMessage => ({
      type: 'STATE',
      stream: this.stream.name,
      state: { fields: this.#fields, links: Object.fromEntries(links) },
    });
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
        yield state();
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

  #gained(read: readonly string[]): boolean {
    return this.#fields.some((field) => !read.includes(field));
  }
}
