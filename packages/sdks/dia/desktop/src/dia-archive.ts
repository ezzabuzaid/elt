import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FileStamp, isErrno } from '@zukhruf/fs';

import { referenceDateInstant } from '@workspace/codec-apple-reference-date';
import { AppFilesVersion } from '@workspace/sdk-macos-app-database';

import { DiaArchiveFormatError, DiaArchiveMissingError } from './errors.ts';

// The format version this SDK reads, the `version` of the file.
const knownVersion = 2;

// Where Dia keeps its archived tabs in the home folder `home`.
export const diaArchivePath = (home: string) =>
  join(home, 'Library/Application Support/Dia/StorableAutoArchive.json');

// A tab that Dia archived: one entry of a profile's archivedTabs.
export type ArchivedTab = {
  // The Chromium profile folder of the tab's profile, such as `Default` or
  // `Profile 1`.
  readonly profileId: string;
  readonly id: string;
  readonly title: string;
  // The case of the variant: `webContent` for a web page, `supertab` for a
  // Dia supertab.
  readonly kind: string;
  // The page's URL; null for a tab that has none, such as a supertab.
  readonly url: string | null;
  // When Dia archived the tab, in UTC to the microsecond.
  readonly archivedAt: string;
  readonly spaceId: string;
  // The tab group the tab was in; null when it was in none.
  readonly groupId: string | null;
  // The variant whole, as JSON text with its keys sorted, so the fields of a
  // supertab are kept and a write that orders the keys differently gives the
  // same text.
  readonly variant: string;
};

// Dia's archive of the tabs it closed. Dia rewrites the whole file while it
// runs; it removes a tab after an age, when the user restores it, or when the
// user deletes it, and records none of these.
export class DiaArchive {
  readonly #path: string;

  constructor(home: string) {
    this.#path = diaArchivePath(home);
  }

  // Every archived tab of every profile, from one read of the file.
  async tabs(): Promise<ArchivedTab[]> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR'))
        throw new DiaArchiveMissingError(this.#path, error);
      throw error;
    }
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (cause) {
      throw new DiaArchiveFormatError(
        this.#path,
        'the file',
        'is not JSON',
        cause,
      );
    }
    return new ArchiveDecoder(this.#path).tabs(document);
  }

  // The change signal: the stat data of the file. Dia writes the file only
  // while it runs, so a closed Dia leaves it as it was.
  version(): AppFilesVersion {
    return new AppFilesVersion(() => [this.#path]);
  }

  // When Dia last wrote the file.
  async lastWrite(): Promise<Date> {
    const { modifiedAt } = await FileStamp.read(this.#path);
    if (modifiedAt === undefined)
      throw new DiaArchiveMissingError(this.#path, undefined);
    return modifiedAt;
  }
}

type JsonObject = { readonly [key: string]: unknown };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The JSON value with each object's keys in sorted order.
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : isObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key])]),
        )
      : value;

class ArchiveDecoder {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  tabs(document: unknown): ArchivedTab[] {
    const archive = this.#object(document, 'the file');
    if (archive.version !== knownVersion)
      throw this.#error(
        'version',
        `is ${JSON.stringify(archive.version) ?? 'absent'}, not ${knownVersion}`,
      );
    return this.#array(archive.containers, 'containers').flatMap(
      (value, index) => {
        const at = `containers[${index}]`;
        const container = this.#object(value, at);
        const id = this.#object(container.id, `${at}.id`);
        const profile = this.#object(id.profile, `${at}.id.profile`);
        const profileId = this.#string(profile._0, `${at}.id.profile._0`);
        return this.#array(container.archivedTabs, `${at}.archivedTabs`).map(
          (tab, index) =>
            this.#tab(profileId, tab, `${at}.archivedTabs[${index}]`),
        );
      },
    );
  }

  #tab(profileId: string, value: unknown, at: string): ArchivedTab {
    const tab = this.#object(value, at);
    const variant = this.#object(tab.variant, `${at}.variant`);
    const [kind, ...others] = Object.keys(variant);
    if (kind === undefined || others.length > 0)
      throw this.#error(
        `${at}.variant`,
        `has ${Object.keys(variant).length} cases, not 1`,
      );
    const archiveDate = tab.archiveDate;
    if (typeof archiveDate !== 'number')
      throw this.#error(`${at}.archiveDate`, 'is not a number');
    return {
      profileId,
      id: this.#string(tab.id, `${at}.id`),
      title: this.#string(tab.title, `${at}.title`),
      kind,
      url: this.#optionalString(tab.url, `${at}.url`),
      archivedAt: referenceDateInstant(archiveDate),
      spaceId: this.#string(tab.spaceID, `${at}.spaceID`),
      groupId: this.#optionalString(tab.groupID, `${at}.groupID`),
      variant: JSON.stringify(sorted(variant)),
    };
  }

  #object(value: unknown, at: string): JsonObject {
    if (!isObject(value)) throw this.#error(at, 'is not an object');
    return value;
  }

  #array(value: unknown, at: string): readonly unknown[] {
    if (!Array.isArray(value)) throw this.#error(at, 'is not a list');
    return value;
  }

  #string(value: unknown, at: string): string {
    if (typeof value !== 'string') throw this.#error(at, 'is not text');
    return value;
  }

  #optionalString(value: unknown, at: string): string | null {
    return value === undefined ? null : this.#string(value, at);
  }

  #error(at: string, problem: string) {
    return new DiaArchiveFormatError(this.#path, at, problem);
  }
}
