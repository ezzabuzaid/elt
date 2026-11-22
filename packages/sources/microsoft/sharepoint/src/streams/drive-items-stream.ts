import { rm } from 'node:fs/promises';

import {
  type CopyConfiguration,
  type RecordDraft,
  type SourceMessage,
  fileExtension,
} from '@eltjs/elt';
import {
  DeltaExpiredError,
  type DeltaPage,
  type DriveItem,
  GraphError,
  type PresentDriveItem,
} from '@eltjs/sdk-microsoft-sharepoint';

import {
  type DeltaState,
  DeltaStream,
  type Link,
  type Walk,
  resumeLink,
} from '../delta-stream.ts';
import type { ScopeFolder } from '../folder-scope.ts';
import type { SharePointRun } from '../sharepoint-run.ts';
import {
  createdBy,
  instant,
  json,
  lastModifiedBy,
  sharePointFields,
  siteUrl,
} from '../sharepoint-stream.ts';

const { id, text, nullableText, boolean, timestamp, count, nullableCount } =
  sharePointFields;

const properties = {
  siteUrl,
  driveId: {
    ...id,
    description: 'The document library of the item: drives.driveId.',
  },
  itemId: { ...id, description: "Graph's ID of the file or the folder." },
  name: {
    ...text,
    description: 'The name of the file or the folder, with its extension.',
  },
  isFolder: { ...boolean, description: 'Whether the item is a folder.' },
  size: {
    ...count,
    description:
      'The size in bytes: of the file, or of every file in the folder.',
  },
  mimeType: {
    ...nullableText,
    description: 'The media type of the file. NULL for a folder.',
  },
  quickXorHash: {
    ...nullableText,
    description:
      'The quickXorHash of the content, in base64. NULL for a folder, or when Graph gives none.',
  },
  sha1Hash: {
    ...nullableText,
    description:
      'The SHA-1 of the content, in hex. NULL when Graph gives none, as for most files of SharePoint.',
  },
  sha256Hash: {
    ...nullableText,
    description:
      'The SHA-256 of the content, in hex. NULL when Graph gives none, as for most files of SharePoint.',
  },
  childCount: {
    ...nullableCount,
    description: 'How many items the folder holds. NULL for a file.',
  },
  parentId: {
    ...nullableText,
    description:
      'The folder that holds the item: its itemId. The root folder of the library has no row.',
  },
  path: {
    ...nullableText,
    description:
      'The path of the folder that holds the item, as Graph gives it, such as /drives/<driveId>/root:/02 BD Resources. NULL when the delta of Graph leaves it out.',
  },
  webUrl: { ...text, description: 'The URL of the file or the folder.' },
  createdDateTime: {
    ...timestamp,
    description: 'When the item was created, in UTC.',
  },
  lastModifiedDateTime: {
    ...timestamp,
    description: 'When the item last changed, in UTC.',
  },
  createdBy,
  lastModifiedBy,
  eTag: {
    ...nullableText,
    description:
      'The version tag of the item, which changes when its content or its metadata changes. NULL when Graph gives none.',
  },
  cTag: {
    ...nullableText,
    description:
      'The version tag of the content of the item, which changes only when the content changes. NULL when the delta of Graph leaves it out.',
  },
  listItemId: {
    ...nullableText,
    description:
      'The item of the library list that holds the metadata columns of the file or the folder: listItems.itemId of the list of the library. NULL when Graph gives none.',
  },
} as const;

// The scope folders of one drive, and each item under them with the folder
// that holds it.
class Subtrees {
  readonly #roots: ReadonlySet<string>;
  readonly items: Map<string, string>;

  constructor(roots: readonly string[], items: Map<string, string>) {
    this.#roots = new Set(roots);
    this.items = items;
  }

  isRoot(id: string): boolean {
    return this.#roots.has(id);
  }

  contains(id: string): boolean {
    return this.#roots.has(id) || this.items.has(id);
  }

  // The item and each item under it.
  subtree(id: string): readonly string[] {
    const found = [id];
    for (let index = 0; index < found.length; index += 1)
      for (const [item, parent] of this.items)
        if (parent === found[index]) found.push(item);
    return found;
  }
}

export class DriveItemsStream extends DeltaStream<DriveItem> {
  constructor() {
    super({
      name: 'driveItems',
      description:
        'One record for each file and folder of each document library of the site, without the root folder of the library, which drives describes. A site limited to folders loads only those folders and what they hold. A copy can take the content of a file through the file of the stream; a field that accepts only some file names downloads only those files. Primary key siteUrl, driveId, itemId. Read through the drive delta of Graph: the first read loads every item, and later reads apply the changes and deletions after it.',
      properties,
      primaryKey: ['siteUrl', 'driveId', 'itemId'],
      covers:
        'Every file and folder of every document library of each configured site, or of its scope folders, then the changes that the drive delta of Graph reports.',
      supportsFileTransfer: true,
    });
  }

  protected async collections(
    url: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    return (await run.drives(url, signal)).map((drive) => drive.id);
  }

  protected pages(
    _url: string,
    driveId: string,
    link: string | undefined,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncIterable<DeltaPage<DriveItem>> {
    return run.client.driveDelta(driveId, link, signal);
  }

  protected async *messages(
    configuration: CopyConfiguration,
    url: string,
    driveId: string,
    item: DriveItem,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<SourceMessage> {
    if (item.deleted !== undefined) {
      yield* this.deletion(configuration, {
        siteUrl: url,
        driveId,
        itemId: item.id,
      });
      return;
    }
    // A delta gives the root folder of the drive on each of its pages (live,
    // 2026-11-17: 31 times over 31 pages), with no eTag and no author.
    if (item.root !== undefined) return;
    const data = this.validated(record(url, driveId, item));
    if (configuration.fileReads.length === 0) {
      yield { stream: this.stream.name, data };
      return;
    }
    const file =
      item.file !== undefined &&
      configuration.fileReads.some((read) => read.accepts(item.name))
        ? await download(run, driveId, item, signal)
        : null;
    try {
      yield { stream: this.stream.name, data, file };
    } finally {
      if (file !== null) await rm(file, { force: true });
    }
  }

  // A site limited to folders loads the scope folders and each item under
  // them (ADR 0003). The first read takes the delta link of each drive, then
  // lists the folders, so a change during the listing comes again in the next
  // read. It saves where the listing stands after each page of children, so
  // a first read that fails lists on from there. Later reads apply the
  // changes of the drive delta to the items under the folders: an item that
  // leaves them is deleted with what it holds, and a folder that enters them
  // is listed, since a delta gives no item again when its folder moves. Other
  // scope folders than the state was read with start the site over with a
  // RESET.
  protected override async *scoped(
    configuration: CopyConfiguration,
    saved: DeltaState | null,
    url: string,
    folders: readonly ScopeFolder[],
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<SourceMessage> {
    // The scope folders as the checkpoint names them.
    const ids = folders.map((it) => `${it.driveId}/${it.item.id}`);
    const from =
      saved !== null &&
      saved.scope !== undefined &&
      sameMembers(saved.scope.folders, ids) &&
      !this.gained(saved.fields)
        ? saved
        : null;
    if (saved !== null && from === null) yield* this.reset();
    try {
      yield* this.#folders(configuration, from, url, folders, ids, run, signal);
    } catch (error) {
      if (!(error instanceof DeltaExpiredError)) throw error;
      yield* this.reset();
      yield* this.#folders(configuration, null, url, folders, ids, run, signal);
    }
  }

  async *#folders(
    configuration: CopyConfiguration,
    from: DeltaState | null,
    url: string,
    folders: readonly ScopeFolder[],
    ids: readonly string[],
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<SourceMessage> {
    const links = new Map<string, Link>(Object.entries(from?.links ?? {}));
    const items = new Map<string, Map<string, string>>(
      Object.entries(from?.scope?.items ?? {}).map(([drive, parents]) => [
        drive,
        new Map(Object.entries(parents)),
      ]),
    );
    const walks = new Map<string, Walk>(
      Object.entries(from?.scope?.walks ?? {}),
    );
    const state = () =>
      this.state(links, {
        folders: ids,
        items: Object.fromEntries(
          [...items].map(([drive, parents]) => [
            drive,
            Object.fromEntries(parents),
          ]),
        ),
        walks: Object.fromEntries(walks),
      });
    for (const driveId of new Set(folders.map((it) => it.driveId))) {
      const roots = folders.filter((it) => it.driveId === driveId);
      const trees = new Subtrees(
        roots.map((it) => it.item.id),
        items.get(driveId) ?? new Map(),
      );
      items.set(driveId, trees.items);
      const link = links.get(driveId);
      if (link === undefined) {
        const open = walks.get(driveId);
        const delta =
          open?.delta ??
          (await run.client.latestDriveDeltaLink(driveId, signal));
        if (open === undefined)
          for (const root of roots)
            yield* this.messages(
              configuration,
              url,
              driveId,
              root.item,
              run,
              signal,
            );
        const listing = this.#list(
          configuration,
          url,
          driveId,
          open ?? {
            folders: roots
              .filter((it) => it.item.folder !== undefined)
              .map((it) => it.item.id),
            next: null,
          },
          trees,
          run,
          signal,
        );
        for await (const message of listing) {
          if (!(message instanceof Listed)) {
            yield message;
            continue;
          }
          const [first, ...rest] = message.folders;
          // The state of the drive's delta link follows the last page.
          if (first === undefined) continue;
          walks.set(driveId, {
            delta,
            folders: [first, ...rest],
            next: message.next,
          });
          yield state();
        }
        walks.delete(driveId);
        links.set(driveId, { delta });
        yield state();
        continue;
      }
      for await (const page of run.client.driveDelta(
        driveId,
        resumeLink(link),
        signal,
      )) {
        for (const item of page.items)
          yield* this.#change(
            configuration,
            url,
            driveId,
            item,
            trees,
            run,
            signal,
          );
        links.set(
          driveId,
          'deltaLink' in page
            ? { delta: page.deltaLink }
            : { next: page.nextLink },
        );
        yield state();
      }
    }
  }

  // An item that enters the scope, and each item under it, listed.
  async *#enter(
    configuration: CopyConfiguration,
    url: string,
    driveId: string,
    item: PresentDriveItem,
    trees: Subtrees,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<SourceMessage> {
    yield* this.messages(configuration, url, driveId, item, run, signal);
    if (item.folder === undefined) return;
    for await (const message of this.#list(
      configuration,
      url,
      driveId,
      { folders: [item.id], next: null },
      trees,
      run,
      signal,
    ))
      if (!(message instanceof Listed)) yield message;
  }

  // Lists folders and each folder under them, breadth first: the messages of
  // each child, and after each page of children where the listing stands.
  // next is the next link of the children of the first folder, or null to
  // list it from the start.
  async *#list(
    configuration: CopyConfiguration,
    url: string,
    driveId: string,
    from: { readonly folders: readonly string[]; readonly next: string | null },
    trees: Subtrees,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<SourceMessage | Listed> {
    // A queue that grows as the listing finds folders.
    const folders = [...from.folders];
    let next = from.next;
    for (let folder = folders[0]; folder !== undefined; folder = folders[0]) {
      for await (const page of run.client.children(
        driveId,
        folder,
        next ?? undefined,
        signal,
      )) {
        for (const child of page.items) {
          trees.items.set(child.id, folder);
          yield* this.messages(configuration, url, driveId, child, run, signal);
          if (child.folder !== undefined) folders.push(child.id);
        }
        next = 'nextLink' in page ? page.nextLink : null;
        if (next === null) folders.shift();
        yield new Listed([...folders], next);
      }
    }
  }

  // One item of a delta of a drive with scope folders. An item outside them
  // that a delta gives before its new folder enters them loads when that
  // folder enters, since the folder is listed then.
  async *#change(
    configuration: CopyConfiguration,
    url: string,
    driveId: string,
    item: DriveItem,
    trees: Subtrees,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<SourceMessage> {
    if (item.deleted !== undefined) {
      yield* this.#leave(configuration, url, driveId, item.id, trees);
      return;
    }
    if (item.root !== undefined) return;
    const parent = item.parentReference.id;
    if (
      !trees.isRoot(item.id) &&
      (parent === undefined || !trees.contains(parent))
    ) {
      yield* this.#leave(configuration, url, driveId, item.id, trees);
      return;
    }
    const entering = !trees.contains(item.id);
    if (!trees.isRoot(item.id) && parent !== undefined)
      trees.items.set(item.id, parent);
    if (entering)
      yield* this.#enter(configuration, url, driveId, item, trees, run, signal);
    else yield* this.messages(configuration, url, driveId, item, run, signal);
  }

  // An item that left the scope, or was deleted, with each item under it.
  *#leave(
    configuration: CopyConfiguration,
    url: string,
    driveId: string,
    id: string,
    trees: Subtrees,
  ): Generator<SourceMessage> {
    if (!trees.contains(id)) return;
    for (const gone of trees.subtree(id)) {
      trees.items.delete(gone);
      yield* this.deletion(configuration, {
        siteUrl: url,
        driveId,
        itemId: gone,
      });
    }
  }
}

// Where a listing of folders stands after a page of children: the folders
// it has still to list, and the next link of the children of the first.
class Listed {
  readonly folders: readonly string[];
  readonly next: string | null;

  constructor(folders: readonly string[], next: string | null) {
    this.folders = folders;
    this.next = next;
  }
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((it) => b.includes(it));
}

function record(
  url: string,
  driveId: string,
  item: PresentDriveItem,
): RecordDraft<typeof properties> {
  return {
    siteUrl: url,
    driveId,
    itemId: item.id,
    name: item.name,
    isFolder: item.folder !== undefined,
    size: item.size,
    mimeType: item.file?.mimeType ?? null,
    quickXorHash: item.file?.hashes?.quickXorHash ?? null,
    sha1Hash: item.file?.hashes?.sha1Hash ?? null,
    sha256Hash: item.file?.hashes?.sha256Hash ?? null,
    childCount: item.folder?.childCount ?? null,
    parentId: item.parentReference.id ?? null,
    path: item.parentReference.path ?? null,
    webUrl: item.webUrl,
    createdDateTime: instant(item.createdDateTime),
    lastModifiedDateTime: instant(item.lastModifiedDateTime),
    createdBy: json(item.createdBy),
    lastModifiedBy: json(item.lastModifiedBy),
    eTag: item.eTag ?? null,
    cTag: item.cTag ?? null,
    listItemId: item.sharepointIds?.listItemId ?? null,
  };
}

// The content of a file, staged in the run's folder under its item ID and
// the extension of its name, which a parser reads the format from. null when
// the file was deleted after the delta listed it: the next delta gives its
// deletion.
async function download(
  run: SharePointRun,
  driveId: string,
  item: PresentDriveItem,
  signal: AbortSignal,
): Promise<string | null> {
  const path = run.staged(`${item.id}${fileExtension(item.name)}`);
  try {
    await run.client.download(driveId, item.id, path, signal);
    return path;
  } catch (error) {
    if (error instanceof GraphError && error.status === 404) return null;
    throw error;
  }
}
