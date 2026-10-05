import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { type PlistValue, parseBinaryPlist } from './plist.ts';

const execute = promisify(execFile);

export async function readPlist(path: string): Promise<PlistValue> {
  // plutil reads any plist format (XML or binary) and rewrites it
  // as binary1, which parseBinaryPlist decodes with dates and data kept native.
  const { stdout } = await execute(
    '/usr/bin/plutil',
    ['-convert', 'binary1', '-o', '-', path],
    { encoding: 'buffer' },
  );
  return parseBinaryPlist(stdout);
}
