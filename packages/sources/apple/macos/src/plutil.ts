import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { type PlistValue, parseBinaryPlist } from './plist.ts';

const execute = promisify(execFile);

export async function readMailPlist(path: string): Promise<PlistValue> {
  // plutil owns XML parsing and converts every plist kind, including dates/data;
  // our existing binary decoder already preserves those native value types.
  const { stdout } = await execute(
    '/usr/bin/plutil',
    ['-convert', 'binary1', '-o', '-', path],
    { encoding: 'buffer' },
  );
  return parseBinaryPlist(stdout);
}
