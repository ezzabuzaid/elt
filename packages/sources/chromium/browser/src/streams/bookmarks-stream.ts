import type { RecordDraft } from '@eltjs/elt';
import {
  type ChromiumBookmark,
  bookmarkRoots,
} from '@eltjs/sdk-chromium-bookmarks';

import type { ChromiumScan, Profiled } from '../chromium-scan.ts';
import { ChromiumStream, chromiumFields } from '../chromium-stream.ts';

const properties = {
  profileId: chromiumFields.profileId,
  guid: {
    ...chromiumFields.text,
    minLength: 1,
    description:
      'The id of the bookmark or folder, the same on each device that syncs it.',
  },
  id: {
    ...chromiumFields.text,
    description: 'The number this profile’s Bookmarks file gives the node.',
  },
  parentGuid: {
    ...chromiumFields.nullableText,
    description:
      'The folder that holds the node; refers to guid of the same profile. Null for a root folder.',
  },
  root: {
    type: 'string',
    enum: bookmarkRoots,
    description:
      'The root folder the node is in: bookmark_bar, other (Other bookmarks), or synced (Mobile bookmarks, from the user’s phones through sync).',
  },
  position: {
    ...chromiumFields.ordinal,
    description: 'The place of the node in its folder, from 0.',
  },
  type: {
    type: 'string',
    enum: ['url', 'folder'],
    description: 'url for a bookmark, folder for a folder.',
  },
  name: {
    ...chromiumFields.text,
    description: 'The title the user sees.',
  },
  url: {
    ...chromiumFields.nullableText,
    description: 'The address of a bookmark; null for a folder.',
  },
  addedAt: {
    ...chromiumFields.instant,
    description:
      'When the node was added; null when the browser recorded none, as Dia does for the bookmarks it imported.',
  },
  lastUsedAt: {
    ...chromiumFields.instant,
    description: 'When the user last opened the bookmark; null when never.',
  },
  modifiedAt: {
    ...chromiumFields.instant,
    description:
      'When the contents of a folder last changed; null for a bookmark, or when the browser recorded none.',
  },
  metaInfo: {
    type: 'array',
    items: {
      type: 'object',
      properties: { key: { type: 'string' }, value: { type: 'string' } },
      required: ['key', 'value'],
    },
    description:
      'What the browser keeps beside the node, by key, such as last_visited_desktop; empty when nothing.',
  },
} as const;

export class BookmarksStream extends ChromiumStream<
  typeof properties,
  Profiled<ChromiumBookmark>
> {
  readonly name = 'bookmarks';
  readonly store = 'bookmarks';
  readonly description =
    'Each bookmark and folder in the Bookmarks file of a profile, with its place in its folder.';
  readonly properties = properties;
  readonly primaryKey = ['profileId', 'guid'];

  protected rows(scan: ChromiumScan) {
    return scan.bookmarks;
  }

  protected record({
    profileId,
    row,
  }: Profiled<ChromiumBookmark>): RecordDraft<typeof properties> {
    return {
      profileId,
      guid: row.guid,
      id: row.id,
      parentGuid: row.parentGuid,
      root: row.root,
      position: row.position,
      type: row.type,
      name: row.name,
      url: row.type === 'url' ? row.url : null,
      addedAt: row.addedAt,
      lastUsedAt: row.lastUsedAt,
      modifiedAt: row.type === 'folder' ? row.modifiedAt : null,
      metaInfo: Object.entries(row.metaInfo ?? {}).map(([key, value]) => ({
        key,
        value,
      })),
    };
  }
}
