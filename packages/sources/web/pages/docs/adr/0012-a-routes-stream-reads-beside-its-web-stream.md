# A routes stream reads beside its web stream

ADR 0011 made the routes stream read after every web stream of the read. Its routes waited in the outbox of the web stream's state, and they reached their table only at the end of the pass. On 2026-10-31, the first pass of the startup-credits app was longer than 15 minutes, and its `program_pages_routes` table did not exist yet, so the alerts that follow the routes had nothing to read (#3487). ADR 0017 of elt refreshes derived data at each commit; the routes must also commit during the crawl.

The outbox stays a transactional outbox. Only the relay changes. A transactional outbox needs a relay that reads the committed rows and gives them on while the producer goes on, as Debezium's `EventRouter` routes each outbox row that the change stream gives ([EventRouterDelegate.java](https://github.com/debezium/debezium/blob/5fe96c08c16e7d33b58396be8a80d5d5d14ba758/debezium-connect-plugins/src/main/java/io/debezium/transforms/outbox/EventRouterDelegate.java#L96-L122)). The source owns this job, because only it knows which groups its web stream's checkpoint holds. elt asks a source for its next message only after the consumer took its last one, so when the yield of a checkpoint returns, the commit of that checkpoint has ended.

Thus:

- `WebSource` reads two streams at a time (`concurrency` 2), and it orders each web stream just before its routes stream.
- After each checkpoint of a web stream, the crawl gives the groups that the checkpoint committed to the routes stream of its input. The routes stream loads them, with their diff, and commits its state with the number of the first group that it did not commit. Groups that come while the routes stream loads go together into its next scan.
- When the crawl of an input ends, it also gives the groups that it found after its last checkpoint, as the routes stream got them before this change, and the routes stream of that input ends. A full refresh that fails reads no later input, so the routes streams of those inputs end too.
- One web stream crawls at a time, as before: a read that selects two web streams and not their routes streams would otherwise crawl both at once.
- A read whose stream throws outside its extract ends the others (ADR 0018 of elt), so a routes stream never waits for a web stream that cannot give more.

## Considered Options

- **The routes stream reads after its web stream.** Routes reach their table only at the end of the pass.
- **The web stream gives the routes records itself.** elt keeps each message to the stream whose extract gave it, and ADR 0011 rejected routes in the page records.
- **The routes stream reads beside its web stream and takes each committed group.** This option was selected.

## Consequences

- A reader sees the routes of a listing during the crawl, after the checkpoint that committed the listing.
- A run that stops between the web stream's commit and the routes stream's commit gives those groups again in the next run, as before.
- In a full refresh, a checkpoint commits nothing, so the routes of a page can commit before the page.
- The test `while the crawl of an input goes on, the routes of each checkpoint reach their table and a view over the pages appears` proves this rule.
