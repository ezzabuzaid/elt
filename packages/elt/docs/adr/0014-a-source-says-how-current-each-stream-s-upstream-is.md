# A source says how current the upstream of each stream is

A watched stream that never changed looked stale, because `stream_status` kept the time of its last pass while the watch continued to check it (#2568). Thus a watch records each check that finds a stream unchanged, and `current_as_of` is the later of the start of the last successful pass and the latest check (elt fb8753ad). A Debezium heartbeat and a Beam watermark show a source that is caught up in the same way.

Then a second problem showed. For a store that an app writes only while it runs (WhatsApp, Notes), or only now and then (Slack, Teams, Mail), a check proves only that the store did not change. It does not prove that the store agrees with the app. WhatsApp closed for a day read as current as of a minute ago.

Thus `Source` has the abstract `currentAsOf(stream): Promise<Date | null>`, as a replica reports the last change that it replayed (`pg_last_xact_replay_timestamp()`). `null` means that the upstream is current each time that the source reads it. It has no default, so each source gives its answer. The pipeline asks before each pass and records the answer with each copy. `current_as_of` is never later than the answer. A copy whose source cannot tell fails with that error and is not read.

## Considered Options

- **The time of the last pass.** A watched stream that does not change looks stale.
- **The time of the last check.** A store that its app did not write reads as current.
- **The later of the last pass and the last check, capped by the answer of the source.** This option was selected.

## Consequences

- A watch asks the source only for a check that it records, at most one time each minute.
- The two histories store `extraction_coverage.upstream_current_as_of`, and `stream_status` and `sync_status` cap `current_as_of` with it.
- context-compiler #2819 decided the answers of Wallet, the history and iCloud Tabs of Safari, and Search Console (elt 83242264).

Sources: elt fb8753ad, d6bddcd5, 83242264; backlog #2568; context-compiler backlog #2603, #2819.
