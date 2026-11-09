import type { ArcSidebarContent } from '@eltjs/sdk-arc-desktop';

import { ArcStream, fields } from '../arc-stream.ts';

const properties = {
  id: { ...fields.id, description: 'The item’s ID.' },
  profileId: fields.profileId,
  spaceId: {
    ...fields.nullableText,
    description:
      'The space that holds the item, the id of the spaces stream; null for a favorite, which every space of its profile shows.',
  },
  section: {
    type: 'string',
    enum: ['pinned', 'unpinned', 'favorites'],
    description:
      'Where the item sits: the pinned or the unpinned part of its space, or the favorites of its profile.',
  },
  parentId: {
    ...fields.nullableText,
    description:
      'The folder or split view that holds the item, the id of another row; null at the top of its section.',
  },
  position: {
    ...fields.position,
    description:
      'The place of the item among the items of its parent, or of its section at the top, from 0.',
  },
  kind: {
    type: 'string',
    enum: ['tab', 'folder', 'note', 'splitView'],
    description:
      'tab: a saved web page. folder: a folder of items (a list in Arc’s file). note: an Arc note. splitView: tabs shown side by side, its children.',
  },
  title: {
    ...fields.nullableText,
    description:
      'The name the user gave the item; null when it has none, then Arc shows a tab’s savedTitle.',
  },
  createdAt: {
    ...fields.instant,
    description: 'When the item was made, in UTC to the microsecond.',
  },
  unread: {
    type: 'boolean',
    description: 'Whether Arc marks the item unread.',
  },
  originatingDeviceId: {
    ...fields.text,
    description: 'The ID Arc gives the device that made the item.',
  },
  widthFactor: {
    type: ['number', 'null'],
    description:
      'The share of its split view’s width the item takes; null when its parent is no split view or Arc keeps no share for it.',
  },
  url: {
    ...fields.nullableText,
    description: 'A tab’s URL; null for other kinds.',
  },
  savedTitle: {
    ...fields.nullableText,
    description:
      'A tab’s page title when Arc last saved it; null for other kinds.',
  },
  muteStatus: {
    ...fields.nullableText,
    description:
      'A tab’s audio setting as Arc writes it, such as allowAudio; null for other kinds.',
  },
  lastActiveAt: {
    ...fields.nullableInstant,
    description:
      'When the user last used the tab, note or split view, in UTC; null for a folder or when Arc keeps no time.',
  },
  referrerId: {
    ...fields.nullableText,
    description:
      'The tab whose page opened this tab; the id of a row only while that tab is still in the sidebar. null for other kinds or when none.',
  },
  openerId: {
    ...fields.nullableText,
    description:
      'The tab that was active when this tab was made (activeTabBeforeCreationID); the id of a row only while that tab is still in the sidebar. null for other kinds or when none.',
  },
  documentId: {
    ...fields.nullableText,
    description:
      'A note’s document ID; Arc keeps the note’s text elsewhere, by this ID. null for other kinds.',
  },
  editable: {
    ...fields.nullableBoolean,
    description: 'Whether the user can edit a note; null for other kinds.',
  },
  layoutOrientation: {
    ...fields.nullableText,
    description:
      'How a split view lays out its tabs, such as horizontal; null for other kinds.',
  },
  focusItemId: {
    ...fields.nullableText,
    description:
      'The tab of a split view that has the focus; null for other kinds or when none.',
  },
  customInfo: {
    ...fields.nullableText,
    description:
      'A split view’s customInfo as the JSON Arc writes; null for other kinds or when none.',
  },
} as const;

export class SidebarItemsStream extends ArcStream<typeof properties> {
  readonly name = 'sidebarItems';
  readonly description =
    'Every item of Arc’s sidebar: the tabs, folders, notes and split views of each space, pinned and unpinned, and each profile’s favorites, as a tree by parentId and position.';
  readonly properties = properties;

  protected rows({ items }: ArcSidebarContent) {
    return items.map((item) => {
      const row = {
        id: item.id,
        profileId: item.profile.id,
        spaceId: item.spaceId,
        section: item.section,
        parentId: item.parentId,
        position: item.position,
        kind: item.kind,
        title: item.title,
        createdAt: item.createdAt,
        unread: item.unread,
        originatingDeviceId: item.originatingDeviceId,
        widthFactor: item.widthFactor,
        url: null,
        savedTitle: null,
        muteStatus: null,
        lastActiveAt: null,
        referrerId: null,
        openerId: null,
        documentId: null,
        editable: null,
        layoutOrientation: null,
        focusItemId: null,
        customInfo: null,
      };
      switch (item.kind) {
        case 'tab':
          return {
            ...row,
            url: item.url,
            savedTitle: item.savedTitle,
            muteStatus: item.muteStatus,
            lastActiveAt: item.lastActiveAt,
            referrerId: item.referrerId,
            openerId: item.openerId,
          };
        case 'folder':
          return row;
        case 'note':
          return {
            ...row,
            documentId: item.documentId,
            editable: item.editable,
            lastActiveAt: item.lastActiveAt,
          };
        case 'splitView':
          return {
            ...row,
            layoutOrientation: item.layoutOrientation,
            lastActiveAt: item.lastActiveAt,
            focusItemId: item.focusItemId,
            customInfo: item.customInfo,
          };
      }
    });
  }
}
