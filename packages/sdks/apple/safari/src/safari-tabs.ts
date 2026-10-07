import {
  type PlistValue,
  decodeArchive,
  parseBinaryPlist,
} from '@workspace/codec-plist';
import { AppDatabase } from '@workspace/sdk-apple-app-database';

import { SafariSchemaError, SafariUnavailableError } from './errors.ts';
import {
  type Dictionary,
  type Row,
  appleTime,
  dictionary,
  flag,
  integer,
  list,
  number,
  plistTime,
  stored,
  storedNumber,
  strings,
  text,
} from './safari-values.ts';
import { type WindowState, windowState } from './window-state.ts';

// The SafariTabs.db columns this reader reads, checked against Safari 27 on
// macOS 27. Its bookmarks table holds profiles, tab groups and tabs; the
// sync columns and the restoration archive are CloudKit and AppKit state.
const tabsColumns = {
  bookmarks: [
    'id',
    'parent',
    'type',
    'subtype',
    'special_id',
    'hidden',
    'title',
    'url',
    'order_index',
    'external_uuid',
    'server_id',
    'last_modified',
    'date_closed',
    'last_selected_child',
    'extra_attributes',
    'local_attributes',
    'topic_title',
  ],
  windows: [
    'id',
    'uuid',
    'active_tab_group_id',
    'active_profile_id',
    'local_tab_group_id',
    'private_tab_group_id',
    'is_last_session',
    'date_closed',
    'scene_id',
    'extra_attributes',
  ],
  windows_tab_groups: ['window_id', 'tab_group_id', 'active_tab_id'],
  windows_profiles: ['window_id', 'profile_id', 'active_tab_group_id'],
  windows_unnamed_tab_groups: ['window_id', 'tab_group_id'],
  settings: ['key', 'value', 'parent'],
} as const;

const select = (table: keyof typeof tabsColumns, order: string) =>
  `SELECT ${tabsColumns[table].join(', ')} FROM ${table} ORDER BY ${order}`;

// SafariTabs.db open read-only and pinned to one moment, refused without the
// columns this reader reads.
export function tabsDatabase(path: string): AppDatabase {
  const database = new AppDatabase(path, SafariUnavailableError);
  database.requireColumns(tabsColumns, SafariSchemaError);
  return database;
}

const folder = 1;
const profileSubtype = 2;
const favoritesSubtype = 1;
const deviceSubtype = 3;
const rootId = 0;

// The only profile every Safari has; its history lives in History.db.
export const defaultProfile = 'DefaultProfile';

export const tabGroupKinds = [
  'named',
  'unnamed',
  'local',
  'private',
  'pinned',
  'privatePinned',
  'recentlyClosed',
  'favorites',
  'device',
  'special',
] as const;
export type TabGroupKind = (typeof tabGroupKinds)[number];

// Folders Safari names by their external_uuid.
const namedSpecials = new Map<unknown, TabGroupKind>(
  (['pinned', 'privatePinned', 'recentlyClosed'] as const).map((kind) => [
    kind,
    kind,
  ]),
);

// A profile row: profiles, tab groups and tabs all live in bookmarks.
const isProfile = (row: Row) =>
  row.type === folder && row.subtype === profileSubtype;

// A profile as SafariTabs.db lists it, and the identifier its History.db is
// filed under: DefaultProfile in ~/Library/Safari, else its server_id.
type ProfileListing = {
  readonly profileId: string | null;
  readonly serverId: string | null;
};

export const profileListings = (database: AppDatabase): ProfileListing[] =>
  database
    .all(select('bookmarks', 'id'))
    .filter(isProfile)
    .map((row) => ({
      profileId: text(row.external_uuid),
      serverId: text(row.server_id),
    }));

// A profile's color, an archived WBSNamedColorOption.
export type ProfileColor = {
  readonly colorName: string | null;
  readonly red: number | null;
  readonly green: number | null;
  readonly blue: number | null;
  readonly alpha: number | null;
};

// One section of a profile's start page, as Safari lists them.
export type StartPageSection = {
  readonly position: number;
  readonly identifier: string;
  readonly enabled: boolean;
};

export type SafariProfile = {
  readonly id: string | null;
  readonly serverId: string | null;
  readonly title: string | null;
  readonly position: number | null;
  readonly symbol: string | null;
  readonly favoritesFolderServerId: string | null;
  readonly addedAt: Date | null;
  readonly modifiedAt: Date | null;
  color(): ProfileColor;
  startPageSections(): StartPageSection[];
};

export type SafariWindow = {
  readonly id: string | null;
  readonly profileId: string | null;
  readonly activeTabGroupId: string | null;
  readonly localTabGroupId: string | null;
  readonly privateTabGroupId: string | null;
  readonly lastSession: boolean;
  readonly sceneId: string | null;
  readonly state: WindowState;
  // When the window closed, from the database or else its saved state.
  readonly closedAt: Date | null;
};

// A window's link to a profile or tab group, with the profile of the window
// itself so a reader can select by it.
export type WindowProfile = {
  readonly windowId: string | null;
  readonly profileId: string | null;
  readonly activeTabGroupId: string | null;
  readonly windowProfileId: string | null;
};

export type WindowTabGroup = {
  readonly windowId: string | null;
  readonly tabGroupId: string | null;
  readonly activeTabId: string | null;
  readonly unnamed: boolean;
  readonly windowProfileId: string | null;
};

export type TabGroup = {
  readonly id: string | null;
  readonly parentId: string | null;
  // NULL for the pinned-tab folders every profile shares.
  readonly profileId: string | null;
  readonly kind: TabGroupKind;
  readonly title: string | null;
  readonly position: number | null;
  readonly hidden: boolean;
  readonly lastSelectedTabId: string | null;
  readonly deviceType: string | null;
  readonly topic: string | null;
  readonly addedAt: Date | null;
  readonly modifiedAt: Date | null;
  readonly closedAt: Date | null;
};

// One page of a tab's back and forward list.
export type TabHistoryEntry = {
  readonly position: number;
  readonly current: boolean;
  readonly url: string | null;
  readonly originalUrl: string | null;
  readonly title: string | null;
  readonly scriptCreated: boolean;
  readonly externalUrlPolicy: string | null;
};

// A tab, with what Safari keeps in its row, in its synced attributes and in
// its attributes local to this Mac, each fallback resolved.
export type Tab = {
  readonly id: string | null;
  readonly tabGroupId: string | null;
  readonly profileId: string | null;
  readonly windowId: string | null;
  readonly position: number | null;
  readonly tabIndex: number | null;
  readonly title: string | null;
  readonly url: string | null;
  readonly localTitle: string | null;
  readonly localUrl: string | null;
  readonly pinned: boolean;
  readonly pinnedTitle: string | null;
  readonly pinnedUrl: string | null;
  readonly addedAt: Date | null;
  readonly lastViewedAt: Date | null;
  readonly lastVisitedAt: Date | null;
  readonly lastAccessedAt: Date | null;
  readonly modifiedAt: Date | null;
  readonly closedAt: Date | null;
  readonly muted: boolean;
  readonly showingReader: boolean;
  readonly readerScrollOffset: number | null;
  readonly openedFromLink: boolean;
  readonly standaloneImage: boolean;
  readonly disposable: boolean;
  readonly safeToLoad: boolean;
  readonly ancestorTabIds: string[];
  readonly deviceId: string | null;
  readonly topic: string | null;
  readonly pageLanguage: string | null;
  readonly pageSummary: string | null;
  readonly pageKeywords: string[];
  readonly pageKeywordWeights: readonly PlistValue[];
  readonly featureText: string | null;
  // Whether the tab is a Favorite of a tab group, read from its parent.
  favorite(): boolean;
  // Its back and forward list from SessionState: a 4-byte version, then a
  // binary property list.
  sessionHistory(): TabHistoryEntry[];
};

const plist = (value: Row[string] | undefined): Dictionary =>
  value instanceof Uint8Array ? dictionary(parseBinaryPlist(value)) : {};

// SafariTabs.db as Safari last saved it: profiles, windows, tab groups and
// tabs. Each row's attributes decode once, when a reader first reads a value
// from them, so a row a reader skips never fails on its attributes.
export class SafariTabs implements Disposable {
  readonly #database: AppDatabase;
  readonly #rows: Row[];
  readonly #byId: Map<unknown, Row>;
  readonly #windows: Row[];
  readonly #attributes = new Map<unknown, [Dictionary, Dictionary]>();
  #settings?: Row[];

  constructor(path: string) {
    this.#database = tabsDatabase(path);
    this.#rows = this.#database.all(select('bookmarks', 'id'));
    this.#byId = new Map(this.#rows.map((row) => [row.id, row]));
    this.#windows = this.#database.all(select('windows', 'id'));
  }

  profiles(): SafariProfile[] {
    return this.#rows.filter(isProfile).map((row) => {
      const extra = () => this.#attributesOf(row)[0];
      return {
        id: stored(row.external_uuid),
        serverId: stored(row.server_id),
        title: text(row.title),
        position: storedNumber(row.order_index),
        get symbol() {
          return text(extra().SymbolImageName);
        },
        get favoritesFolderServerId() {
          return text(extra().CustomFavoritesFolderServerID);
        },
        get addedAt() {
          return plistTime(dictionary(extra()['com.apple.Bookmark']).DateAdded);
        },
        modifiedAt: appleTime(row.last_modified),
        color: () => this.#color(row),
        startPageSections: () => this.#startPageSections(row),
      };
    });
  }

  windows(): SafariWindow[] {
    return this.#windows.map((row) => {
      let state: WindowState | undefined;
      const decoded = () =>
        (state ??= windowState(plist(row.extra_attributes)));
      return {
        id: stored(row.uuid),
        profileId: this.#uuid(row.active_profile_id),
        activeTabGroupId: this.#uuid(row.active_tab_group_id),
        localTabGroupId: this.#uuid(row.local_tab_group_id),
        privateTabGroupId: this.#uuid(row.private_tab_group_id),
        lastSession: flag(row.is_last_session),
        sceneId: text(row.scene_id),
        get state() {
          return decoded();
        },
        get closedAt() {
          return appleTime(row.date_closed) ?? decoded().closedAt;
        },
      };
    });
  }

  // Links of windows that exist, in the database's order.
  windowProfiles(): WindowProfile[] {
    return this.#database
      .all(select('windows_profiles', 'window_id, profile_id'))
      .flatMap((row) => {
        const window = this.#window(row.window_id);
        if (window === undefined) return [];
        return [
          {
            windowId: text(window.uuid),
            profileId: this.#uuid(row.profile_id),
            activeTabGroupId: this.#uuid(row.active_tab_group_id),
            windowProfileId: this.#uuid(window.active_profile_id),
          },
        ];
      });
  }

  // A window's tab groups: those it shows, then its unnamed groups. A group
  // in both keeps its place and its active tab, marked unnamed.
  windowTabGroups(): WindowTabGroup[] {
    const unnamed = this.#database.all(
      select('windows_unnamed_tab_groups', 'window_id, tab_group_id'),
    );
    const active = this.#database.all(
      select('windows_tab_groups', 'window_id, tab_group_id'),
    );
    const key = (row: Row) => `${row.window_id}:${row.tab_group_id}`;
    const pairs = new Map<string, Row>();
    for (const row of active) pairs.set(key(row), { ...row, unnamed: 0 });
    for (const row of unnamed)
      pairs.set(key(row), {
        active_tab_id: null,
        ...pairs.get(key(row)),
        ...row,
        unnamed: 1,
      });
    return [...pairs.values()].flatMap((row) => {
      const window = this.#window(row.window_id);
      if (window === undefined) return [];
      return [
        {
          windowId: text(window.uuid),
          tabGroupId: this.#uuid(row.tab_group_id),
          activeTabId: this.#uuid(row.active_tab_id),
          unnamed: flag(row.unnamed),
          windowProfileId: this.#uuid(window.active_profile_id),
        },
      ];
    });
  }

  tabGroups(): TabGroup[] {
    return this.#rows
      .filter(
        (row) =>
          row.type === folder &&
          row.id !== rootId &&
          row.subtype !== profileSubtype,
      )
      .map((row) => {
        const extra = () => this.#attributesOf(row)[0];
        const kind = () => this.#kind(row);
        return {
          id: stored(row.external_uuid),
          parentId: row.parent === rootId ? null : this.#uuid(row.parent),
          profileId: this.#profileOf(row),
          get kind() {
            return kind();
          },
          title: text(row.title),
          position: storedNumber(row.order_index),
          hidden: flag(row.hidden),
          lastSelectedTabId: this.#uuid(row.last_selected_child),
          get deviceType() {
            return text(extra().DeviceTypeIdentifier);
          },
          topic: text(row.topic_title),
          get addedAt() {
            return plistTime(
              dictionary(extra()['com.apple.Bookmark']).DateAdded,
            );
          },
          modifiedAt: appleTime(row.last_modified),
          closedAt: appleTime(row.date_closed),
        };
      });
  }

  tabs(): Tab[] {
    return this.#rows
      .filter((row) => row.type !== folder)
      .map((row) => {
        const [extra, local] = this.#attributesOf(row);
        const context = dictionary(local.TabPageContextIDKey);
        return {
          id: stored(row.external_uuid),
          tabGroupId: this.#uuid(row.parent),
          profileId: this.#profileOf(row),
          windowId: text(local.WindowUUID),
          position: storedNumber(row.order_index),
          tabIndex: integer(local.TabIndex),
          title: text(row.title),
          url: text(row.url),
          localTitle: text(extra.LocalTitle),
          localUrl: text(extra.LocalURL),
          pinned: flag(extra.IsPinned) || flag(local.IsPinned),
          pinnedTitle: text(extra.PinnedTitle) ?? text(local.PinnedPageTitle),
          pinnedUrl: text(extra.PinnedAddress) ?? text(local.PinnedPageURL),
          addedAt: plistTime(dictionary(extra['com.apple.Bookmark']).DateAdded),
          lastViewedAt: plistTime(extra.DateLastViewed),
          lastVisitedAt: plistTime(local.LastVisitTime),
          lastAccessedAt: plistTime(local.LastAccessDate),
          modifiedAt: appleTime(row.last_modified),
          closedAt: appleTime(row.date_closed) ?? plistTime(local.DateClosed),
          muted: flag(local.IsMuted),
          showingReader: flag(local.ShowingReader),
          readerScrollOffset: number(local.ReaderViewTopScrollOffset),
          openedFromLink: flag(local.OpenedFromLink),
          standaloneImage: flag(local.DisplayingStandaloneImage),
          disposable: flag(local.IsDisposable),
          safeToLoad: flag(local.SafeToLoad),
          ancestorTabIds: strings(local.AncestorTabUUIDsKey),
          deviceId: text(extra.DeviceIdentifier),
          topic: text(row.topic_title) ?? text(context.topicID),
          pageLanguage: text(context.pageLanguage),
          pageSummary: text(context.summary),
          pageKeywords: strings(context.keywords),
          pageKeywordWeights: list(context.keywordsWeights),
          featureText: text(extra.featureText),
          favorite: () => {
            const parent = this.#byId.get(row.parent);
            return parent !== undefined && this.#kind(parent) === 'favorites';
          },
          sessionHistory: () => sessionHistory(local),
        };
      });
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }

  // A row's own attributes and its attributes local to this Mac.
  #attributesOf(row: Row): [extra: Dictionary, local: Dictionary] {
    let found = this.#attributes.get(row.id);
    if (found === undefined) {
      found = [plist(row.extra_attributes), plist(row.local_attributes)];
      this.#attributes.set(row.id, found);
    }
    return found;
  }

  #color(profile: Row): ProfileColor {
    this.#settings ??= this.#database.all(select('settings', 'parent'));
    const setting = this.#settings.find(
      (row) => row.parent === profile.id && row.key === 'ProfileColor',
    );
    const color =
      setting?.value instanceof Uint8Array
        ? dictionary(decodeArchive(setting.value))
        : {};
    return {
      colorName: text(color.colorName),
      red: number(color.redComponent),
      green: number(color.greenComponent),
      blue: number(color.blueComponent),
      alpha: number(color.alphaComponent),
    };
  }

  #startPageSections(profile: Row): StartPageSection[] {
    const data = this.#attributesOf(profile)[0].StartPageSectionsData;
    if (!(data instanceof Uint8Array)) return [];
    const {
      Sections,
    }: { Sections: { Identifier: string; IsEnabled: boolean }[] } = JSON.parse(
      Buffer.from(data).toString('utf8'),
    );
    return Sections.map((section, position) => ({
      position,
      identifier: section.Identifier,
      enabled: section.IsEnabled,
    }));
  }

  #window(id: unknown): Row | undefined {
    return this.#windows.find((window) => window.id === id);
  }

  #uuid(id: unknown): string | null {
    return text(this.#byId.get(id)?.external_uuid);
  }

  #kind(row: Row): TabGroupKind {
    const named = namedSpecials.get(row.external_uuid);
    if (named !== undefined) return named;
    if (Number(row.special_id) > 0) return 'special';
    if (row.subtype === favoritesSubtype) return 'favorites';
    if (row.subtype === deviceSubtype) return 'device';
    if (this.#windows.some((window) => window.private_tab_group_id === row.id))
      return 'private';
    if (this.#windows.some((window) => window.local_tab_group_id === row.id))
      return 'local';
    return this.#attributesOf(row)[0].IsUnnamed === true ? 'unnamed' : 'named';
  }

  // The profile a row belongs to: its nearest profile folder; under the root,
  // the default profile; a window's own groups, that window's profile; a
  // tab's page context names its profile. NULL when Safari records none.
  #profileOf(row: Row): string | null {
    if (row.type !== folder) {
      const context = dictionary(
        this.#attributesOf(row)[1].TabPageContextIDKey,
      );
      const named = text(context.profileIdentifier);
      if (named !== null) return named;
    }
    for (
      let current: Row | undefined = row;
      current !== undefined;
      current = this.#byId.get(current.parent)
    ) {
      if (isProfile(current)) return text(current.external_uuid);
      if (current.parent === rootId) return defaultProfile;
      const window = this.#windows.find(
        (window) =>
          window.local_tab_group_id === current?.id ||
          window.private_tab_group_id === current?.id ||
          window.active_tab_group_id === current?.id,
      );
      if (window !== undefined) return this.#uuid(window.active_profile_id);
    }
    return null;
  }
}

function sessionHistory(local: Dictionary): TabHistoryEntry[] {
  const state = local.SessionState;
  if (!(state instanceof Uint8Array)) return [];
  const session = dictionary(
    dictionary(parseBinaryPlist(state.subarray(4))).SessionHistory,
  );
  const current = session.SessionHistoryCurrentIndex;
  return list(session.SessionHistoryEntries).map((value, position) => {
    const entry = dictionary(value);
    return {
      position,
      current: position === current,
      url: text(entry.SessionHistoryEntryURL),
      originalUrl: text(entry.SessionHistoryEntryOriginalURL),
      title: text(entry.SessionHistoryEntryTitle),
      scriptCreated: flag(
        entry.SessionHistoryEntryWasCreatedByJSWithoutUserInteraction,
      ),
      externalUrlPolicy: text(
        entry.SessionHistoryEntryShouldOpenExternalURLsPolicyKey,
      ),
    };
  });
}
