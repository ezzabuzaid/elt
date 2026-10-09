import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { Selection } from './selection.ts';

// What a store holds: its settings file and each import directory. Changing
// what is stored, such as a settings table or a table name a checkpoint binds
// to, takes a new layout: every connector imports afresh, the settings file is
// rebuilt, and processes running older code stop writing.
export const storeLayout = 7;

// Thrown by a process whose code predates the layout of the settings file.
export class NewerLayoutError extends Error {
  constructor() {
    super('A newer version wrote this store; use that version.');
  }
}

// Where a connector's import lives: one directory per selection and layout, so
// a pass still writing an earlier one never touches the current one.
export function importDirectory(root: string, selection: Selection): string {
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        storeLayout,
        selection.scope,
        selection.includeAttachments,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
  return join(root, selection.connector, key);
}
