import { homedir } from 'node:os';
import { join } from 'node:path';

import { readPlist } from '@workspace/sdk-apple-plist';

import { MailSchemaError } from './errors.ts';
import { plistObject } from './mail-plists.ts';

export const mailDirectory = join(homedir(), 'Library/Mail');

// Mail keeps each layout of its store in a version folder, such as V10, and
// names the current one in PersistenceInfo.plist.
export async function mailVersionDirectory(root: string): Promise<string> {
  const info = plistObject(
    await readPlist(join(root, 'PersistenceInfo.plist')),
  );
  const version = info.LastUsedVersionDirectoryName;
  if (typeof version !== 'string' || !/^V\d+$/.test(version))
    throw new MailSchemaError('Mail has no valid current version directory');
  return join(root, version);
}

// The index of a version folder.
export const envelopeIndexPath = (directory: string) =>
  join(directory, 'MailData/Envelope Index');
