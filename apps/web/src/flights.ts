import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { SingleFlight } from '@zukhruf/single-flight';

import directory from './directory.ts';

const flightsDirectory = join(directory, 'flights');
await mkdir(flightsDirectory, { recursive: true });

// A Sync or Clear while the same one runs joins it, in this process or another
// that uses the folder. A Clear during a Sync is refused by elt's checkpoint
// lock.
export default new SingleFlight<void>({
  directory: flightsDirectory,
  codec: { encode: () => '', decode: () => undefined },
});
