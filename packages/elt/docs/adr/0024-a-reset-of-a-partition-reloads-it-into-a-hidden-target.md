# A reset of a partition reloads it into a hidden target

ADR 0007 moved a reload of a whole stream into a hidden target, because readers saw a part of the table while the reload ran. Its last consequence kept the old rule for partitions: a `RESET` of a partition emptied that partition at the next commit. No record says why. The SharePoint source partitions by site, and it resets a site when Microsoft Graph refuses its delta link (`410`). It then reloads about 6,400 items, with a checkpoint for each page, so a reader that does not read as of a position, such as the MCP of datahub, saw the site half loaded until the reload ended (backlog #4572).

Thus a reset of a partition reloads that partition into the hidden target, and the other partitions load into the target as before. When the stream ends with no failure, the rows of the reloaded partitions in the target are replaced by those of the hidden target, by difference. A row that the reload brings again stays with its commit. This is the rule of Delta Lake's `replaceWhere`, Spark's dynamic partition overwrite and BigQuery's partition decorator: a write replaces only the partitions that it selects, and every other partition stays as it is.

## Considered Options

- **Empty the partition at the next commit.** Readers see a half-loaded partition. This was the rule.
- **Reload the whole table, with the other partitions copied into the hidden target first.** It needs no new state, but the rows of the other partitions show only when the reload ends, and the copy is the size of the table.
- **Reload only the reset partitions, and keep the others live.** This option was selected.

## Consequences

- The destination records the partitions of an open reload beside the hidden target (`_elt_reloads`), in the transaction of each commit, so a reload that a failure stopped continues them in the next run. The engine still saves only whether a reload is open.
- Each commit gives the staged rows of the reloaded partitions to the hidden target and the other rows to the target. A staged `DELETE` whose key does not name its partition goes to both, so the reload cannot bring back a row that the source deleted.
- A reset that no commit took is undone with the operations after it, when a failure discards them. Otherwise a later run would replace the partition with only the rows that it loaded since.
- A reset of the whole stream during the reload of a partition starts a reload of the whole stream.
- An overwrite replaces the whole table, so its reset of a partition keeps the old rule.

Sources: #4572.
