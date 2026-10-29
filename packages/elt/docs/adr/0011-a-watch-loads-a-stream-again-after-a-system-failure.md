# A watch loads a stream again after a system failure

A watch loads a stream only when its source reports a change. Thus a stream whose copy failed stayed stale until the next change. For example, "Checkpoint calendar:accounts is in use by another run" failed each Calendar copy, and each stayed failed until Calendar changed again. Search Console waited for the next change in traffic, up to six hours (#2050).

Thus the pipeline loads again, with no change, a stream whose copy failed for a `system` reason. The pipeline owns the retries, not the source, because the pipeline sees the outcome of each copy and its failure type, and `observe()` of a source does not. The delay after the n-th failure in a row is `min(10 s × 3^(n-1), 30 min)`: 10, 30, 90 and 270 seconds. A success, a failure that is only `config`, or the fifth failure in a row ends the series. The next change of the source starts a new series. This is the rule of the platform of Airbyte (`RetryManager` and `BackoffPolicy`): a complete failure backs off from 10 s with base 3 to at most 30 minutes, at most 5 complete failures in a row, and a config error never again, because only the user can fix it.

The same change made errors that no history recorded show as themselves. `watch()` rejects with a `WatchError` that holds only the watcher failures that the history recorded. An error that no history recorded stops each connection at once and rejects as itself. When the history cannot record why a connection stopped, the pipeline throws a `SuppressedError` (#2566).

## Considered Options

- **Wait for the next change of the source.** A failed stream stays stale for hours or never wakes.
- **The source tries again.** The source does not see the outcomes of the copies.
- **The pipeline tries again with the back-off of Airbyte.** This option was selected.

## Consequences

- The limit of 10 failures in all of Airbyte does not apply, because a watch does not count progress, so the limit of 5 in a row comes first. The cap of 30 minutes does not apply either, because the last delay is 270 seconds.
- No test waits for the longer delays, because the pipeline has no clock seam.

Sources: elt ab3c5c30; backlog #2050, #2566.
