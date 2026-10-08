import { homedir } from 'node:os';
import { join } from 'node:path';

// Where the plugin keeps settings.sqlite and every import; the query-apple
// skill tells readers the same path.
export const appleDirectory = () =>
  join(homedir(), 'Library/Application Support/Context Compiler/Apple');
