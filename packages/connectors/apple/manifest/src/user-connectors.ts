import { homedir } from 'node:os';
import { join } from 'node:path';

// Where the user's own connectors live, one folder each, beside the
// built-in ones: an agent adds a connector here without a release.
export const userConnectors = join(
  homedir(),
  'Library/Application Support/Context Compiler/Connectors',
);
