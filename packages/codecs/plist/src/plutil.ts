import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { type PlistValue, parseBinaryPlist } from './plist.ts';

const execute = promisify(execFile);

export async function readPlist(path: string): Promise<PlistValue> {
  // plutil reads any plist format (XML or binary) and rewrites it
  // as binary1, which parseBinaryPlist decodes with dates and data kept native.
  // Its output is as large as the list, so no buffer limit cuts it short.
  const { stdout } = await execute(
    '/usr/bin/plutil',
    ['-convert', 'binary1', '-o', '-', path],
    { encoding: 'buffer', maxBuffer: Infinity },
  );
  return parseBinaryPlist(stdout);
}
