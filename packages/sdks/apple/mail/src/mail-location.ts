import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { UnavailableError } from '@zukhruf/sqlite-data-version';

import { isBinaryPlist, parseBinaryPlist, readPlist } from '@eltjs/codec-plist';
import { StoreUnavailableError } from '@eltjs/sdk-macos-app-database';

import { mailStore } from './app-database.ts';
import { MailSchemaError } from './errors.ts';
import { plistObject } from './mail-plists.ts';

// Mail's store in the home folder `home`.
export const mailDirectory = (home: string): string =>
  join(home, 'Library/Mail');

// Mail keeps each layout of its store in a version folder, such as V10, and
// names the current one in PersistenceInfo.plist. The file is read before it
// is parsed, so a store this process cannot read fails as unavailable, and a
// file it can read but not parse fails as itself.
export async function mailVersionDirectory(root: string): Promise<string> {
  const path = join(root, 'PersistenceInfo.plist');
  const bytes = await readFile(path).catch((cause: unknown) => {
    const unavailable = UnavailableError.from(path, cause);
    if (unavailable === undefined) throw cause;
    throw new StoreUnavailableError(mailStore, root, unavailable);
  });
  const info = plistObject(
    isBinaryPlist(bytes) ? parseBinaryPlist(bytes) : await readPlist(path),
  );
  const version = info.LastUsedVersionDirectoryName;
  if (typeof version !== 'string' || !/^V\d+$/.test(version))
    throw new MailSchemaError('Mail has no valid current version directory');
  return join(root, version);
}

// The index of a version folder.
export const envelopeIndexPath = (directory: string) =>
  join(directory, 'MailData/Envelope Index');
