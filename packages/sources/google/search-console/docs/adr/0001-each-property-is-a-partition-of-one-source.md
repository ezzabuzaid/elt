# Each property is a partition of one source

A user can have many properties. At first, `SearchConsoleSource` took one `siteUrl`. Thus each property needed its own pipeline, and the id of each copy had to name the property (6e3c4388). The rows did not tell which property they came from. Thus two properties that loaded into one table wrote over each other. The analytics grains upserted on keys such as `[date, searchType]`, and a full-refresh overwrite of a listing emptied the table (7438f4db).

Two changes repaired this:

- Each stream other than `sites` has a `siteUrl` field, and each key starts with it (7438f4db).
- `SearchConsoleOptions` takes `siteUrls`. Each stream other than `sites` is partitioned by `siteUrl`. Each property has its own checkpoint. Thus a new property reads all of its history while the other properties resume, and the source identity does not name a property (6e3c4388).

`sites` is the list of the grant itself, so it has no `siteUrl` partition. The report types stay in the identity, `search-console:<report types>`, because they change which rows exist. The properties do not change which rows a property has. Thus they are partitions and not part of the identity.

## Considered Options

- **One source for each property, and the copy id names the property.** Several pipelines then write into the same tables, and each table has more than one writer.
- **The property in the source identity.** The identity is part of the checkpoint binding, so a new property binds each checkpoint again.
- **One source with a partition for each property.** This option was selected.

## Consequences

- One source reads all properties, so each table has one writer.
- When you add a property, the source reads its history, and the other properties resume.
- When you remove a property, the source stops reading it and keeps its rows.
- The Google app gives each property to one source.

Sources: commits 6e3c4388 and 7438f4db.
