import { type Snapshot } from '@zukhruf/sqlite-snapshot';

import { ProtobufMessage } from '@workspace/codec-protobuf';

import { appDatabase } from './app-database.ts';
import { bytes, instant, requiredText, unixSecondInstant } from './values.ts';

// One of the account's privacy settings, as WhatsApp names its category and
// value (who sees last seen, profile photo, About; who adds to groups...).
export type PrivacySetting = {
  readonly category: string;
  readonly value: string;
};

// A WhatsApp account's own default timer for new chats' messages.
export type DisappearingMode = {
  readonly lid: string;
  // 0 when off.
  readonly durationSeconds: number;
  readonly setAt: string | null;
};

// An account a person links to their WhatsApp profile, such as Instagram.
export type LinkedProfile = {
  readonly lid: string;
  readonly type: string;
  readonly username: string | null;
  readonly url: string | null;
};

// A person who moved WhatsApp to a new phone number.
export type ChangedNumber = {
  readonly oldJid: string;
  readonly newJid: string;
  readonly changedAt: string | null;
};

export type FavoriteSticker = {
  readonly fileHash: string;
  readonly favoritedAt: string | null;
};

// A sticker in the picker's recent list, in its order.
export type RecentSticker = {
  readonly fileHash: string;
  readonly position: number;
  readonly score: number | null;
  // Unix milliseconds, or 0 or 1 where WhatsApp has no time.
  readonly lastUsed: number | null;
};

type Element = {
  readonly key: string;
  readonly value: Uint8Array;
  readonly date: string | null;
};

const requiredColumns = {
  ZWAKEYVALUEELEMENT: ['Z_PK', 'ZNAMESPACE', 'ZKEY', 'ZVALUE', 'ZDATE'],
};

// One of WhatsApp's key-value stores as of one moment. Each holds namespaces
// of keys; only those that hold the account's settings or what it knows of
// people are read. The rest are caches, tokens, queues and telemetry.
class KeyValueSnapshot implements Disposable {
  readonly #database: Snapshot;

  constructor(path: string) {
    this.#database = appDatabase.snapshot(path, requiredColumns);
  }

  elements(namespace: string): IteratorObject<Element, undefined> {
    return this.#database
      .iterate(
        `SELECT ZKEY AS key, ZVALUE AS value, ZDATE AS date
         FROM ZWAKEYVALUEELEMENT WHERE ZNAMESPACE = ? ORDER BY ZSORT, Z_PK`,
        namespace,
      )
      .map((row) => {
        const value = bytes(row.value);
        if (value === null)
          throw new TypeError(`A WhatsApp ${namespace} entry has no value`);
        return {
          key: requiredText(
            row.key,
            `A WhatsApp ${namespace} entry has no key`,
          ),
          value,
          date: instant(row.date),
        };
      });
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}

const utf8 = (value: Uint8Array) =>
  new TextDecoder('utf-8', { fatal: true }).decode(value);

// LocalKeyValue.sqlite: the settings and what WhatsApp learned of people on
// this device.
export class LocalKeyValueSnapshot extends KeyValueSnapshot {
  privacySettings(): IteratorObject<PrivacySetting, undefined> {
    return this.elements('privacy-settings-values').map(({ key, value }) => ({
      category: key,
      value: utf8(value),
    }));
  }

  // A protobuf of the timer in seconds (1) and when it was set in Unix
  // seconds (2), 0 when never.
  disappearingModes(): IteratorObject<DisappearingMode, undefined> {
    return this.elements('disappearing-mode').map(({ key, value }) => {
      const mode = new ProtobufMessage(value);
      const setAt = mode.uint(2) ?? 0;
      return {
        lid: key,
        durationSeconds: mode.uint(1) ?? 0,
        setAt: setAt === 0 ? null : unixSecondInstant(setAt),
      };
    });
  }

  // A JSON list of { type, username, url, vid }; vid is a token for the
  // viewer and is not read.
  linkedProfiles(): IteratorObject<LinkedProfile, undefined> {
    return this.elements('linked-profiles').flatMap(({ key, value }) => {
      const profiles: unknown = JSON.parse(utf8(value));
      if (!Array.isArray(profiles))
        throw new TypeError('WhatsApp linked profiles are not a list');
      return profiles.map((profile: unknown) => {
        if (typeof profile !== 'object' || profile === null)
          throw new TypeError('A WhatsApp linked profile is not an object');
        const type = 'type' in profile ? profile.type : undefined;
        const username = 'username' in profile ? profile.username : undefined;
        const url = 'url' in profile ? profile.url : undefined;
        return {
          lid: key,
          type: requiredText(type, 'A WhatsApp linked profile has no type'),
          username: typeof username === 'string' ? username : null,
          url: typeof url === 'string' ? url : null,
        };
      });
    });
  }

  changedNumbers(): IteratorObject<ChangedNumber, undefined> {
    return this.elements('changenumber-oldtonew').map(
      ({ key, value, date }) => ({
        oldJid: key,
        newJid: utf8(value),
        changedAt: date,
      }),
    );
  }
}

// BackedUpKeyValue.sqlite: what WhatsApp backs up with the account.
export class BackedUpKeyValueSnapshot extends KeyValueSnapshot {
  // Keyed by the sticker's file hash; the date is when it was favorited.
  favoriteStickers(): IteratorObject<FavoriteSticker, undefined> {
    return this.elements('fs.v2').map(({ key, date }) => ({
      fileHash: key,
      favoritedAt: date,
    }));
  }

  // One protobuf whose repeated field 1 lists the stickers by score, each
  // with its file hash (1), score (2) and last use (3).
  recentStickers(): IteratorObject<RecentSticker, undefined> {
    return this.elements('rs.v2').flatMap(({ value }) =>
      new ProtobufMessage(value).messages(1).map((entry, position) => ({
        fileHash: requiredText(
          entry.string(1),
          'A recent WhatsApp sticker has no hash',
        ),
        position,
        score: entry.float(2) ?? null,
        lastUsed: entry.uint(3) ?? null,
      })),
    );
  }
}
