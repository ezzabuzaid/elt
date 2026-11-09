import { readFileSync } from 'node:fs';

import { FileStamp } from '@zukhruf/fs';

import { chromiumInstant } from '@eltjs/codec-chromium-time';
import { AppFilesVersion } from '@eltjs/sdk-macos-app-database';

import { BookmarksFormatError, BookmarksUnavailableError } from './errors.ts';

// The three folders every Bookmarks file has, as BookmarkCodec names them:
// the bookmarks bar, Other bookmarks, and Mobile bookmarks that sync brings
// from the user's phones.
export const bookmarkRoots = ['bookmark_bar', 'other', 'synced'] as const;
export type BookmarkRoot = (typeof bookmarkRoots)[number];

type Node = {
  // Stable across syncs and devices; id is the number this file gives it.
  readonly guid: string;
  readonly id: string;
  // The folder that holds the node; null for a root.
  readonly parentGuid: string | null;
  readonly root: BookmarkRoot;
  // The place of the node in its folder, from 0.
  readonly position: number;
  readonly name: string;
  readonly addedAt: string | null;
  readonly lastUsedAt: string | null;
  // Each meta_info key and its text, such as last_visited_desktop.
  readonly metaInfo: Readonly<Record<string, string>> | null;
};

export type ChromiumBookmark =
  | (Node & { readonly type: 'url'; readonly url: string })
  | (Node & { readonly type: 'folder'; readonly modifiedAt: string | null });

type RawNode = Record<string, unknown>;

const isObject = (value: unknown): value is RawNode =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// One profile's Bookmarks file, as BookmarkCodec writes it: each root folder
// and every folder and URL in it. Chromium replaces the file in one step, so
// a read sees one whole version of it.
export class ChromiumBookmarks {
  readonly path: string;
  readonly bookmarks: readonly ChromiumBookmark[];

  private constructor(path: string, bookmarks: readonly ChromiumBookmark[]) {
    this.path = path;
    this.bookmarks = bookmarks;
  }

  static read(path: string): ChromiumBookmarks {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (cause) {
      throw new BookmarksUnavailableError(path, { cause });
    }
    let file: unknown;
    try {
      file = JSON.parse(text);
    } catch (cause) {
      throw new BookmarksFormatError(path, 'it is not JSON', { cause });
    }
    if (!isObject(file) || !isObject(file.roots))
      throw new BookmarksFormatError(path, 'it has no roots');
    const roots = file.roots;
    const bookmarks = bookmarkRoots.flatMap((root) => {
      const node = roots[root];
      if (!isObject(node))
        throw new BookmarksFormatError(path, `it has no ${root} folder`);
      return [...flatten(path, node, root, null, 0)];
    });
    return new ChromiumBookmarks(path, bookmarks);
  }

  // Changes with each write: Chromium replaces the file whole.
  static stamp(path: string): Promise<FileStamp> {
    return FileStamp.read(path);
  }

  // The change signal of the Bookmarks files that files lists at each read.
  static version(files: () => readonly string[]): AppFilesVersion {
    return new AppFilesVersion(files);
  }
}

function* flatten(
  path: string,
  node: RawNode,
  root: BookmarkRoot,
  parentGuid: string | null,
  position: number,
): Generator<ChromiumBookmark> {
  const { guid, id, name, type } = node;
  if (
    typeof guid !== 'string' ||
    typeof id !== 'string' ||
    typeof name !== 'string'
  )
    throw new BookmarksFormatError(path, 'a node has no guid, id or name');
  const common = {
    guid,
    id,
    parentGuid,
    root,
    position,
    name,
    addedAt: time(path, node.date_added),
    lastUsedAt: time(path, node.date_last_used),
    metaInfo: metaInfo(path, node.meta_info),
  };
  if (type === 'url') {
    if (typeof node.url !== 'string')
      throw new BookmarksFormatError(path, `the URL node ${guid} has no url`);
    yield { ...common, type, url: node.url };
    return;
  }
  if (type !== 'folder')
    throw new BookmarksFormatError(
      path,
      `the node ${guid} has a type ${String(type)}`,
    );
  yield { ...common, type, modifiedAt: time(path, node.date_modified) };
  const children = node.children ?? [];
  if (!Array.isArray(children))
    throw new BookmarksFormatError(
      path,
      `the folder ${guid} has no children list`,
    );
  for (const [index, child] of children.entries()) {
    if (!isObject(child))
      throw new BookmarksFormatError(
        path,
        `the folder ${guid} holds a node that is no object`,
      );
    yield* flatten(path, child, root, guid, index);
  }
}

// BookmarkCodec writes each time as a decimal string of Chromium's
// microseconds, "0" when it has none; a node that never had one has no key.
function time(path: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new BookmarksFormatError(path, `a time is ${JSON.stringify(value)}`);
  return chromiumInstant(BigInt(value));
}

function metaInfo(
  path: string,
  value: unknown,
): Readonly<Record<string, string>> | null {
  if (value === undefined) return null;
  if (!isTextByKey(value))
    throw new BookmarksFormatError(path, 'a meta_info is not text by key');
  return value;
}

const isTextByKey = (value: unknown): value is Record<string, string> =>
  isObject(value) &&
  Object.values(value).every((entry) => typeof entry === 'string');
