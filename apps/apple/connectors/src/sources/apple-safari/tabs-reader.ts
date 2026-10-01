import { decodeArchive, parseBinaryPlist } from '../../platform/macos/plist.ts';
import type { SafariDatabase } from '../../platform/macos/safari-store.ts';
import { type ImportScope, selected } from '../import-scope.ts';
import {
  type Dictionary,
  defaultProfile,
  dictionary,
  list,
  type Row,
  text,
} from './safari-values.ts';

// The SafariTabs.db columns this connector reads, checked against Safari 27
// on macOS 27. Its bookmarks table holds profiles, tab groups and tabs; the
// sync columns and the restoration archive are CloudKit and AppKit state.
export const tabsColumns = {
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

const folder = 1;
const profileSubtype = 2;
const favoritesSubtype = 1;
const deviceSubtype = 3;
const rootId = 0;
// Folders Safari names by their external_uuid.
const namedSpecials = new Set(['pinned', 'privatePinned', 'recentlyClosed']);

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

// A tab's back and forward list: SessionState is a 4-byte version, then a
// binary property list.
export type HistoryEntry = {
  readonly tab: Row;
  readonly entry: Dictionary;
  readonly position: number;
  readonly current: boolean;
};

// One run's read of SafariTabs.db: profiles, windows, tab groups and tabs as
// Safari last saved them. Attributes decode once per row. The scope's
// profiles select profile rows, windows, groups and tabs.
export class TabsReader {
  readonly #rows: Row[];
  readonly #byId: Map<unknown, Row>;
  readonly #windows: Row[];
  readonly #attributes = new Map<unknown, [Dictionary, Dictionary]>();

  constructor(
    readonly database: SafariDatabase,
    readonly scope: ImportScope,
  ) {
    this.#rows = database.all(select('bookmarks', 'id'));
    this.#byId = new Map(this.#rows.map((row) => [row.id, row]));
    this.#windows = database.all(select('windows', 'id'));
  }

  // Every profile, and where its History.db lives: the default profile's is
  // ~/Library/Safari, another's the Profiles folder named by its server_id.
  get allProfiles(): Row[] {
    return this.#rows.filter(
      (row) => row.type === folder && row.subtype === profileSubtype,
    );
  }

  get profiles(): Row[] {
    return this.allProfiles.filter((row) =>
      selected(this.scope.collectionIds, row.external_uuid),
    );
  }

  get windows(): Row[] {
    return this.#windows.filter((window) =>
      selected(this.scope.collectionIds, this.uuid(window.active_profile_id)),
    );
  }

  // Folders of no profile, such as pinned tabs, are shared by every profile,
  // so any profile's scope keeps them.
  get tabGroups(): Row[] {
    return this.#rows.filter(
      (row) =>
        row.type === folder &&
        row.id !== rootId &&
        row.subtype !== profileSubtype &&
        (this.profileOf(row) === null || this.#included(row)),
    );
  }

  get tabs(): Row[] {
    return this.#rows.filter(
      (row) => row.type !== folder && this.#included(row),
    );
  }

  get windowTabGroups(): Row[] {
    const windows = new Set(this.windows.map((window) => window.id));
    const unnamed = this.database
      .all(select('windows_unnamed_tab_groups', 'window_id, tab_group_id'))
      .filter((row) => windows.has(row.window_id));
    const active = this.database
      .all(select('windows_tab_groups', 'window_id, tab_group_id'))
      .filter((row) => windows.has(row.window_id));
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
    return [...pairs.values()];
  }

  get windowProfiles(): Row[] {
    const windows = new Set(this.windows.map((window) => window.id));
    return this.database
      .all(select('windows_profiles', 'window_id, profile_id'))
      .filter((row) => windows.has(row.window_id));
  }

  // Each profile's color, an archived WBSNamedColorOption.
  color(profile: Row): Dictionary {
    const setting = this.database
      .all(select('settings', 'parent'))
      .find((row) => row.parent === profile.id && row.key === 'ProfileColor');
    return setting?.value instanceof Uint8Array
      ? dictionary(decodeArchive(setting.value))
      : {};
  }

  // A row's own attributes and its attributes local to this Mac.
  attributes(row: Row): [extra: Dictionary, local: Dictionary] {
    let found = this.#attributes.get(row.id);
    if (found === undefined) {
      found = [plist(row.extra_attributes), plist(row.local_attributes)];
      this.#attributes.set(row.id, found);
    }
    return found;
  }

  windowState(window: Row): Dictionary {
    return plist(window.extra_attributes);
  }

  row(id: unknown): Row | undefined {
    return this.#byId.get(id);
  }

  uuid(id: unknown): string | null {
    return text(this.#byId.get(id)?.external_uuid);
  }

  windowUuid(id: unknown): string | null {
    return text(this.#windows.find((window) => window.id === id)?.uuid);
  }

  kind(row: Row): TabGroupKind {
    const uuid = row.external_uuid as string;
    if (namedSpecials.has(uuid)) return uuid as TabGroupKind;
    if (Number(row.special_id) > 0) return 'special';
    if (row.subtype === favoritesSubtype) return 'favorites';
    if (row.subtype === deviceSubtype) return 'device';
    if (this.#windows.some((window) => window.private_tab_group_id === row.id))
      return 'private';
    if (this.#windows.some((window) => window.local_tab_group_id === row.id))
      return 'local';
    return this.attributes(row)[0].IsUnnamed === true ? 'unnamed' : 'named';
  }

  // The profile a row belongs to: its nearest profile folder; under the root,
  // the default profile; a window's own groups, that window's profile; a
  // tab's page context names its profile. NULL when Safari records none.
  profileOf(row: Row): string | null {
    if (row.type !== folder) {
      const context = dictionary(this.attributes(row)[1].TabPageContextIDKey);
      const named = text(context.profileIdentifier);
      if (named !== null) return named;
    }
    for (
      let current: Row | undefined = row;
      current !== undefined;
      current = this.#byId.get(current.parent)
    ) {
      if (current.type === folder && current.subtype === profileSubtype)
        return current.external_uuid as string;
      if (current.parent === rootId) return defaultProfile;
      const window = this.#windows.find(
        (window) =>
          window.local_tab_group_id === current?.id ||
          window.private_tab_group_id === current?.id ||
          window.active_tab_group_id === current?.id,
      );
      if (window !== undefined) return this.uuid(window.active_profile_id);
    }
    return null;
  }

  historyEntries(): HistoryEntry[] {
    return this.tabs.flatMap((tab) => {
      const state = this.attributes(tab)[1].SessionState;
      if (!(state instanceof Uint8Array)) return [];
      const session = dictionary(
        dictionary(parseBinaryPlist(state.subarray(4))).SessionHistory,
      );
      const current = session.SessionHistoryCurrentIndex;
      return list(session.SessionHistoryEntries).map((entry, position) => ({
        tab,
        entry: dictionary(entry),
        position,
        current: position === current,
      }));
    });
  }

  #included(row: Row): boolean {
    return selected(this.scope.collectionIds, this.profileOf(row));
  }
}

const plist = (value: Row[string] | undefined): Dictionary =>
  value instanceof Uint8Array ? dictionary(parseBinaryPlist(value)) : {};
