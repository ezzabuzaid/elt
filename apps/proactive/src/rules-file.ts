import { homedir } from 'node:os';
import { join } from 'node:path';

// The rules that users wrote are in proactive's own folder, not in the
// warehouse, which a fresh run makes again.
export const rulesFolder = join(
  homedir(),
  'Library/Application Support/Context Compiler/Proactive',
);
export const rulesFile = join(rulesFolder, 'rules.sqlite');
