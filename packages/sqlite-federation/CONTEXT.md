# SQLite federation

A host keeps its data in many SQLite databases, for example one database for each connector. A statement must read some of them together, for example to join messages with contacts. One SQLite connection can attach at most 10 databases, and the SQLite in Node cannot raise that limit. This package gives one read-only handle over every database that the host can locate. Each statement attaches the databases that it names, and detaches them when it ends.

## Language

**Database**:
A SQLite file that the host gives a name.
_Avoid_: Import (an import is one way that a host keeps a database), file (the host decides where the file is), store

**Name**:
The schema name that a statement uses for a database, for example `mail` in `mail.messages`.
_Avoid_: Alias, key, id

**Locate**:
The port of the host. It gives the path of the database for a name, or `undefined` when the host has no database with that name.
_Avoid_: Resolve, look up, map

**Handle**:
`sql`, the read-only surface that statements use.
_Avoid_: Connection (the handle has one connection, but the connection is not the handle), client, session

**Statement**:
One call of `sql.all` or `sql.get`.
_Avoid_: Query (a query can have many statements), evaluation (in eca, one evaluation runs a full condition)

**Attach**:
To open a database on the connection of the handle, for one statement.
_Avoid_: Mount, load, open

**Limit**:
The number of databases that one SQLite connection can attach at the same time. It is 10 in the SQLite of Node.
_Avoid_: Cap, maximum, quota
