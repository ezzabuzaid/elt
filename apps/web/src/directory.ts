import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const directory = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
  'elt',
  'web',
);
await mkdir(directory, { recursive: true });

export default directory;
