import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FileStamp } from '@zukhruf/fs';

import { referenceDateInstant } from '@workspace/codec-apple-reference-date';
import { AppFilesVersion } from '@workspace/sdk-macos-app-database';

import { ArcSidebarFormatError, ArcSidebarUnavailableError } from './errors.ts';

// A Chromium profile of Arc, named by its folder in Arc/User Data, such as
// Default or Profile 2: the same name Arc's History and Bookmarks are under.
export type ArcProfile = {
  readonly id: string;
  // The Mac that made a profile other than Default, as Arc names it.
  readonly machineId: string | null;
};

// Where an item sits: the pinned or the unpinned part of a space, or the
// favorites of a profile, which every space of that profile shows.
export type ArcSection = 'pinned' | 'unpinned' | 'favorites';

export type ArcSpace = {
  readonly id: string;
  // The place of the space in the sidebar, from 0.
  readonly position: number;
  readonly title: string | null;
  readonly profile: ArcProfile;
  // The emoji the user gave the space as its icon.
  readonly emoji: string | null;
  // The space's theme and icon (customInfo), as the JSON Arc writes.
  readonly customInfo: string;
};

type ItemCommon = {
  readonly id: string;
  readonly profile: ArcProfile;
  // null for a favorite, which belongs to no space.
  readonly spaceId: string | null;
  readonly section: ArcSection;
  // The folder or split view that holds the item; null at the top of its
  // section.
  readonly parentId: string | null;
  // The place of the item among its parent's children, from 0.
  readonly position: number;
  // The name the user gave the item; null when it has none.
  readonly title: string | null;
  readonly createdAt: string;
  readonly unread: boolean;
  // The device that made the item.
  readonly originatingDeviceId: string;
  // The share of a split view's width the item takes; null when its parent
  // is no split view or Arc keeps no share for it.
  readonly widthFactor: number | null;
};

export type ArcTab = ItemCommon & {
  readonly kind: 'tab';
  readonly url: string;
  // The page's own title when Arc last saved the tab; null when Arc saved
  // none.
  readonly savedTitle: string | null;
  readonly muteStatus: string;
  readonly lastActiveAt: string | null;
  // The tab whose page opened this tab.
  readonly referrerId: string | null;
  // The tab that was active when this tab was made.
  readonly openerId: string | null;
};

// A folder of the sidebar; Arc's file calls it a list.
export type ArcFolder = ItemCommon & { readonly kind: 'folder' };

// An Arc note, a document Arc keeps by its own ID; the sidebar holds only
// the reference.
export type ArcNote = ItemCommon & {
  readonly kind: 'note';
  readonly documentId: string;
  readonly editable: boolean;
  readonly lastActiveAt: string | null;
};

// Tabs shown side by side; its children are the tabs.
export type ArcSplitView = ItemCommon & {
  readonly kind: 'splitView';
  readonly layoutOrientation: string;
  readonly lastActiveAt: string | null;
  readonly focusItemId: string | null;
  // The JSON Arc writes as the split view's customInfo; null when none.
  readonly customInfo: string | null;
};

export type ArcSidebarItem = ArcTab | ArcFolder | ArcNote | ArcSplitView;

export type ArcSidebarContent = {
  readonly spaces: readonly ArcSpace[];
  readonly items: readonly ArcSidebarItem[];
};

// The place of a section's container: what each item under it inherits.
type Place = {
  readonly profile: ArcProfile;
  readonly spaceId: string | null;
  readonly section: ArcSection;
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Arc's sidebar, StorableSidebar.json: every space and every item of every
// space and profile, as Arc saved them last. Arc keeps dated copies beside
// it (StorableSidebar.<date>.json); they are backups, and are not read.
export class ArcSidebar {
  readonly path: string;

  constructor(home: string) {
    this.path = join(
      home,
      'Library/Application Support/Arc/StorableSidebar.json',
    );
  }

  async read(): Promise<ArcSidebarContent> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (cause) {
      throw new ArcSidebarUnavailableError(this.path, { cause });
    }
    let file: unknown;
    try {
      file = JSON.parse(text);
    } catch (cause) {
      throw new ArcSidebarFormatError(this.path, 'it is not JSON', { cause });
    }
    return new Decoder(this.path).sidebar(file);
  }

  // The change signal: the file's stat data. Arc replaces the file on each
  // save, so a save changes the stamp.
  version(): AppFilesVersion {
    return new AppFilesVersion(() => [this.path]);
  }

  // Arc writes the file only while it runs, so the sidebar is current as of
  // its last write.
  async lastWrite(): Promise<Date> {
    const { modifiedAt } = await FileStamp.read(this.path);
    if (modifiedAt === undefined)
      throw new ArcSidebarUnavailableError(this.path);
    return modifiedAt;
  }
}

class Decoder {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  #fail(reason: string): never {
    throw new ArcSidebarFormatError(this.#path, reason);
  }

  sidebar(file: unknown): ArcSidebarContent {
    if (!isObject(file)) this.#fail('it is not a JSON object');
    if (file.version !== 1)
      this.#fail(`it has version ${JSON.stringify(file.version)}, not 1`);
    const sidebar = this.#object(file.sidebar, 'the sidebar');
    const containers = this.#array(sidebar.containers, 'the containers');
    const container = containers.find(
      (entry) => isObject(entry) && 'spaces' in entry,
    );
    if (!isObject(container)) this.#fail('it has no container of spaces');
    const spaces = this.#pairs(container.spaces, 'the spaces').map(
      ([id, value], position) => this.#space(id, value, position),
    );
    const items = new Map(
      this.#pairs(container.items, 'the items').map(([id, value]) => [
        id,
        this.#object(value, `the item ${id}`),
      ]),
    );
    return { spaces, items: this.#items(spaces, container.spaces, items) };
  }

  #space(id: string, value: unknown, position: number): ArcSpace {
    const space = this.#object(value, `the space ${id}`);
    if (space.id !== id) this.#fail(`the space ${id} has another id`);
    const customInfo = this.#object(
      space.customInfo,
      `the customInfo of the space ${id}`,
    );
    const icon = customInfo.iconType;
    return {
      id,
      position,
      title: this.#optionalText(space.title, `the title of the space ${id}`),
      profile: this.#profile(space.profile, `the profile of the space ${id}`),
      emoji: isObject(icon)
        ? this.#optionalText(icon.emoji_v2, `the emoji of the space ${id}`)
        : null,
      customInfo: JSON.stringify(customInfo),
    };
  }

  // Arc writes a profile as {default: {}} or {custom: {_0: {...}}}, the
  // way Swift encodes an enum case and its value.
  #profile(value: unknown, what: string): ArcProfile {
    const profile = this.#object(value, what);
    if (isObject(profile.default)) return { id: 'Default', machineId: null };
    const custom = this.#object(
      this.#object(profile.custom, what)._0,
      `the custom ${what}`,
    );
    return {
      id: this.#text(custom.directoryBasename, `the folder of ${what}`),
      machineId: this.#text(custom.machineID, `the machine of ${what}`),
    };
  }

  // Walks each section's container through its childrenIds, the order the
  // sidebar shows, so each item gets its place, parent and position.
  #items(
    spaces: readonly ArcSpace[],
    spaceList: unknown,
    items: ReadonlyMap<string, Json>,
  ): ArcSidebarItem[] {
    const sections = this.#sections(spaceList);
    const decoded: ArcSidebarItem[] = [];
    const reached = new Set<string>();
    for (const [id, item] of items) {
      const data = this.#object(item.data, `the data of the item ${id}`);
      if (!('itemContainer' in data)) continue;
      reached.add(id);
      const place = this.#place(id, data.itemContainer, spaces, sections);
      this.#children(id, item, null, place, items, reached, decoded);
    }
    for (const id of items.keys())
      if (!reached.has(id))
        this.#fail(`the item ${id} is in no space and in no favorites`);
    return decoded;
  }

  // Each space lists its two containers as kind and ID in turn:
  // ["pinned", <id>, "unpinned", <id>].
  #sections(
    spaceList: unknown,
  ): ReadonlyMap<string, { spaceId: string; section: ArcSection }> {
    const sections = new Map<
      string,
      { spaceId: string; section: ArcSection }
    >();
    for (const [id, value] of this.#pairs(spaceList, 'the spaces')) {
      const space = this.#object(value, `the space ${id}`);
      for (const [kind, container] of this.#pairs(
        space.containerIDs,
        `the containers of the space ${id}`,
      )) {
        if (kind !== 'pinned' && kind !== 'unpinned')
          this.#fail(`the space ${id} has a container of kind ${kind}`);
        sections.set(this.#text(container, `a container of ${id}`), {
          spaceId: id,
          section: kind,
        });
      }
    }
    return sections;
  }

  #place(
    id: string,
    value: unknown,
    spaces: readonly ArcSpace[],
    sections: ReadonlyMap<string, { spaceId: string; section: ArcSection }>,
  ): Place {
    const type = this.#object(
      this.#object(value, `the container ${id}`).containerType,
      `the type of the container ${id}`,
    );
    if (isObject(type.topApps))
      return {
        profile: this.#profile(type.topApps._0, `the favorites ${id}`),
        spaceId: null,
        section: 'favorites',
      };
    const spaceId = this.#text(
      this.#object(type.spaceItems, `the type of the container ${id}`)._0,
      `the space of the container ${id}`,
    );
    const space = spaces.find((space) => space.id === spaceId);
    if (space === undefined)
      this.#fail(`the container ${id} names the space ${spaceId}, not found`);
    const listed = sections.get(id);
    if (listed?.spaceId !== spaceId)
      this.#fail(`the space ${spaceId} does not list its container ${id}`);
    return { profile: space.profile, spaceId, section: listed.section };
  }

  #children(
    parentId: string,
    parent: Json,
    itemParentId: string | null,
    place: Place,
    items: ReadonlyMap<string, Json>,
    reached: Set<string>,
    decoded: ArcSidebarItem[],
  ): void {
    const children = this.#array(
      parent.childrenIds,
      `the children of ${parentId}`,
    );
    const widths = this.#widthFactors(parentId, parent);
    for (const child of widths.keys())
      if (!children.includes(child))
        this.#fail(`the split view ${parentId} sizes ${child}, no child of it`);
    for (const [position, value] of children.entries()) {
      const id = this.#text(value, `a child of ${parentId}`);
      const item = items.get(id);
      if (item === undefined)
        this.#fail(`the item ${parentId} lists a child ${id}, not found`);
      if (item.parentID !== parentId)
        this.#fail(
          `the item ${parentId} lists ${id}, whose parent is ${String(item.parentID)}`,
        );
      if (reached.has(id)) this.#fail(`the item ${id} is listed twice`);
      reached.add(id);
      decoded.push(
        this.#item(id, item, {
          ...place,
          parentId: itemParentId,
          position,
          widthFactor: widths.get(id) ?? null,
        }),
      );
      this.#children(id, item, id, place, items, reached, decoded);
    }
  }

  // A split view keeps a share of its width for some of its tabs, as tab ID
  // and share in turn.
  #widthFactors(id: string, item: Json): ReadonlyMap<string, number> {
    const data = this.#object(item.data, `the data of the item ${id}`);
    if (!isObject(data.splitView)) return new Map();
    return new Map(
      this.#pairs(
        data.splitView.itemWidthFactors,
        `the width factors of ${id}`,
      ).map(([child, share]) => {
        if (typeof share !== 'number')
          this.#fail(`the split view ${id} has a share that is no number`);
        return [child, share];
      }),
    );
  }

  #item(
    id: string,
    item: Json,
    place: Place & Pick<ItemCommon, 'parentId' | 'position' | 'widthFactor'>,
  ): ArcSidebarItem {
    const what = `the item ${id}`;
    const common: ItemCommon = {
      id,
      ...place,
      title: this.#optionalText(item.title, `the title of ${what}`),
      createdAt: this.#instant(item.createdAt, `the creation of ${what}`),
      unread: this.#boolean(item.isUnread, `the unread flag of ${what}`),
      originatingDeviceId: this.#text(
        item.originatingDevice,
        `the device of ${what}`,
      ),
    };
    const data = this.#object(item.data, `the data of ${what}`);
    const kinds = Object.keys(data);
    const [kind] = kinds;
    if (kind === undefined || kinds.length !== 1)
      this.#fail(`${what} has the kinds ${JSON.stringify(kinds)}`);
    const value = this.#object(data[kind], `the ${kind} of ${what}`);
    const lastActiveAt = () =>
      value.timeLastActiveAt === undefined
        ? null
        : this.#instant(value.timeLastActiveAt, `the last use of ${what}`);
    switch (kind) {
      case 'tab':
        return {
          ...common,
          kind: 'tab',
          url: this.#text(value.savedURL, `the URL of ${what}`),
          savedTitle: this.#optionalText(
            value.savedTitle,
            `the saved title of ${what}`,
          ),
          muteStatus: this.#text(value.savedMuteStatus, `the mute of ${what}`),
          lastActiveAt: lastActiveAt(),
          referrerId: this.#optionalText(
            value.referrerID,
            `the referrer of ${what}`,
          ),
          openerId: this.#optionalText(
            value.activeTabBeforeCreationID,
            `the opener of ${what}`,
          ),
        };
      case 'list':
        return { ...common, kind: 'folder' };
      case 'arcDocument':
        return {
          ...common,
          kind: 'note',
          documentId: this.#text(
            value.arcDocumentID,
            `the document of ${what}`,
          ),
          editable: this.#boolean(value.isEditable, `the editable of ${what}`),
          lastActiveAt: lastActiveAt(),
        };
      case 'splitView':
        return {
          ...common,
          kind: 'splitView',
          layoutOrientation: this.#text(
            value.layoutOrientation,
            `the layout of ${what}`,
          ),
          lastActiveAt: lastActiveAt(),
          focusItemId: this.#optionalText(
            value.focusItemID,
            `the focus of ${what}`,
          ),
          customInfo:
            value.customInfo === null || value.customInfo === undefined
              ? null
              : JSON.stringify(value.customInfo),
        };
      default:
        return this.#fail(`${what} is of the kind ${kind}, which is unknown`);
    }
  }

  // Swift encodes a dictionary as its keys and values in turn; Arc writes
  // its items, spaces and containers so.
  #pairs(value: unknown, what: string): [string, unknown][] {
    const list = this.#array(value, what);
    if (list.length % 2 !== 0) this.#fail(`${what} have an odd length`);
    const pairs: [string, unknown][] = [];
    for (let index = 0; index < list.length; index += 2)
      pairs.push([
        this.#text(list[index], `a key of ${what}`),
        list[index + 1],
      ]);
    return pairs;
  }

  #object(value: unknown, what: string): Json {
    if (!isObject(value)) this.#fail(`${what} is not an object`);
    return value;
  }

  #array(value: unknown, what: string): unknown[] {
    if (!Array.isArray(value)) this.#fail(`${what} is not a list`);
    return value;
  }

  #text(value: unknown, what: string): string {
    if (typeof value !== 'string') this.#fail(`${what} is not text`);
    return value;
  }

  // Swift leaves out an optional with no value, or writes null.
  #optionalText(value: unknown, what: string): string | null {
    return value === undefined || value === null
      ? null
      : this.#text(value, what);
  }

  #boolean(value: unknown, what: string): boolean {
    if (typeof value !== 'boolean') this.#fail(`${what} is not a boolean`);
    return value;
  }

  // Swift's Date: seconds since 2001-01-01 UTC.
  #instant(value: unknown, what: string): string {
    if (typeof value !== 'number' || !Number.isFinite(value))
      this.#fail(`${what} is not a number of seconds`);
    return referenceDateInstant(value);
  }
}
