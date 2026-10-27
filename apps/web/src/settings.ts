import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type Settings, settingsSchema } from './contract.ts';
import directory from './directory.ts';

const path = join(directory, 'sites.json');

export default {
  read: async (): Promise<Settings> =>
    existsSync(path)
      ? settingsSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      : { inputs: [], include: [] },
  save: (settings: Settings) =>
    writeFile(path, JSON.stringify(settings, null, 2)),
};
