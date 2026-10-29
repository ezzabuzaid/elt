# The host makes the copies and the reader views

At first, the source package had `search-console-marts.ts`. It imported `@workspace/elt-postgresql` and held 17 hand-written views, and the Google app installed them after `pipeline.run()`. On 2026-10-05, Ezz said that this place was wrong: views over the data of a connector belong to the connector level, not to the source. The same decision applied to Apple (#2216). The views stay stored Postgres views, because `agent_reader` has no `TEMP` privilege and cannot read the raw schema. Thus the views are also the access limit of the reader (#2229).

000da177 resolved #2229 in a different way. The Google host makes its copies itself, as `apps/proactive` does. Each stream loads into `google_search_console.raw_<stream>`, with the reader view `marts.search_console_<snake_stream>` and the copy id `search-console:<stream>`. The source has no hand-written marts or copies, and it has no Postgres dependency at run time. The field descriptions hold the aggregation formulas (000da177).

## Considered Options

- **Hand-written marts in the source package.** The source then depends on Postgres, and the views are not at the connector level.
- **Move the marts to a new Google connector package.** No such package existed, and the views stayed hand-written.
- **The host makes each copy with a reader view, and each field description holds its formula.** This option was selected.

## Consequences

- The source works with each destination.
- The reader views show the columns of the raw tables and `loaded_at`, with the description of each field as the column comment.
- A reader reads the formulas for `ctr` and `position` in the column comments.

Sources: commit 000da177; backlog #2229 and #2216.
