import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import directory from './directory.ts';

export const articlesPath = join(directory, 'articles.sqlite');

// Opened read-write so a first start creates the file, which readOnly cannot;
// query_only then refuses every write on this connection.
const db = new DatabaseSync(articlesPath, { timeout: 5_000 });
db.exec('PRAGMA query_only = ON');

export default db;
