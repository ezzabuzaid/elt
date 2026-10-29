# A watch keeps watching after an incomplete pass

One Search Console property whose access was revoked stopped live updates for each other property. `Pipeline.watch()` threw on each pass that did not load completely.

Thus `watch()` yields the outcome of each copy for each pass: the committed counts and the failures, which are empty when the copy is complete. Then it continues to watch. The failed partitions keep their checkpoints. Airbyte also keeps the schedule of a connection after a failed sync. Its automatic disable after 30 failed jobs and 7 days is not used: the caller sees the failures in each pass.

## Considered Options

- **The watch throws on an incomplete pass.** One failed property stops all others.
- **The watch yields the failures and continues.** This option was selected.

## Consequences

- `run()` still throws `PipelineError`. A failed watcher still ends its connection.
- Live on 2026-09-25, a watch over `sc-domain:ezz.sh` and `sc-domain:example.com` (no permission) stayed open, loaded `ezz.sh`, and reported `example.com` in its first pass.

Sources: elt 8d9a7c8e.
