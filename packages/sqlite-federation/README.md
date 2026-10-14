# @workspace/sqlite-federation

A host keeps its data in many SQLite databases, for example one database for each connector. A statement must read some of them together, for example to join messages with contacts. One SQLite connection can attach at most 10 databases, and the SQLite in Node cannot raise that limit. This package gives one read-only handle over every database that the host can locate. Each statement attaches the databases that it names, and detaches them when it ends. This is also known as query federation: one query reads many separate databases.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This package is a workspace package of this repository. It uses only `node:sqlite`. It runs on Node 24.21, the Node of ChatGPT, and on later versions.

## Read many databases with one handle

The host gives `locate`. A statement names each database as a schema.

```ts
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Federation } from '@workspace/sqlite-federation';

await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
const messagesPath = join(scratch.path, 'messages.sqlite');
const contactsPath = join(scratch.path, 'contacts.sqlite');
{
  using messages = new DatabaseSync(messagesPath);
  messages.exec(`CREATE TABLE messages (handle TEXT, text TEXT);
    INSERT INTO messages VALUES ('+962790000000', 'See you at 6');`);
  using contacts = new DatabaseSync(contactsPath);
  contacts.exec(`CREATE TABLE contacts (phone TEXT, name TEXT);
    INSERT INTO contacts VALUES ('+962790000000', 'Sara');`);
}
const paths = new Map([
  ['messages', messagesPath],
  ['contacts', contactsPath],
]);

using federation = new Federation({ locate: (name) => paths.get(name) });
console.log(federation.sql.all`
  SELECT c.name, m.text
  FROM messages.messages m JOIN contacts.contacts c ON c.phone = m.handle`);
```

Output:

```
[ [Object: null prototype] { name: 'Sara', text: 'See you at 6' } ]
```

- `sql` has `all` and `get` of the `SQLTagStore` of `node:sqlite`. A value in `${}` is a bound parameter.
- A statement names each database as a schema: `messages.messages`. A table without a schema reads from `main`, which is empty.
- `locate(name)` returns the path of the database, or `undefined` when the host has no database with that name. The handle calls it for each statement, so it reads a database from its new path after the host moves it.
- Return `undefined` for a database that the host has not written yet. The handle cannot make a database, so an attach of a path with no file fails.
- The handle is read-only. A statement that writes fails with `attempt to write a readonly database`.
- `using` closes the connection of the handle at the end of its scope.

## Each statement attaches what it names

- SQLite fails with `no such table: <name>.<table>` when a statement names a database that is not attached. The handle attaches the database with that name and runs the statement again. It never parses the statement. [ADR 0002](./docs/adr/0002-the-error-of-sqlite-names-the-database.md) tells why.
- When the statement ends, the handle detaches each database that it attached, also when the statement fails. An attach costs less than 1 ms. [ADR 0001](./docs/adr/0001-each-statement-attaches-what-it-names.md) tells why.
- Between two statements, the handle holds no lock. A writer in another connection or process can commit.
- One statement can name at most 10 databases. To read more, split the statement and join the rows in code. [ADR 0003](./docs/adr/0003-a-statement-over-the-limit-fails.md) tells why.

## Errors

| Error                                  | When                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TooManyDatabasesError`                | A statement names more databases than the limit. `names` has at least one name more than the limit. The message tells you to split the statement. |
| `no such table: <name>.<table>`        | The error of SQLite, when `locate` returns `undefined` for the name, or when the database does not have the table.                                |
| `unable to open database file`         | The error of SQLite, when `locate` returns a path with no file.                                                                                   |
| `attempt to write a readonly database` | The error of SQLite, when a statement writes.                                                                                                     |
| The error of `locate`                  | When `locate` throws, the statement fails with that error. The databases that the statement attached before are detached.                         |

## The same concepts in other systems

| System                    | What it does                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite `swarmvtab`        | A virtual table over one table in many databases. It opens each database on its own connection and closes the least recently used one. It is an extension that Node does not include. |
| Datasette `--crossdb`     | It attaches the first 10 databases and ignores the others.                                                                                                                            |
| `q` (harelba/q)           | It attaches databases up to the limit, and copies the tables of the others into a temporary database.                                                                                 |
| PostgreSQL `postgres_fdw` | A foreign table reads a table of another server, and one query can join it with local tables.                                                                                         |

## Documentation

- [0001 Each statement attaches what it names](./docs/adr/0001-each-statement-attaches-what-it-names.md)
- [0002 The error of SQLite names the database](./docs/adr/0002-the-error-of-sqlite-names-the-database.md)
- [0003 A statement over the limit fails](./docs/adr/0003-a-statement-over-the-limit-fails.md)

## Development

```sh
npx nx run sqlite-federation:typecheck
npx nx run sqlite-federation:test
```

```
src/
  index.ts                       the exports
  federation.ts                  Federation, Query and Locate
  too-many-databases-error.ts    TooManyDatabasesError
  federation.test.ts             the tests, on real SQLite files
```
