import { open } from '@zukhruf/sqlite-open';

// Each row of node:sqlite has a null prototype, which a strict deepEqual with
// an object literal refuses, so a test reads copies.
export function storedRows(path: string, sql: string) {
  using database = open(path, { readOnly: true });
  return database
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}
