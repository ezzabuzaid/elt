import { join } from 'node:path';

import { openDestination } from '@eltjs/elt-sqlite';

import directory from './directory.ts';

export const articlesPath = join(directory, 'articles.sqlite');

// Opened read-write so a first start creates the file, which readOnly cannot;
// query_only then refuses every write on this connection. It opens as the
// loads do, so that its close also keeps the -wal and -shm files.
const db = openDestination(articlesPath);
db.exec('PRAGMA query_only = ON');

export default db;
