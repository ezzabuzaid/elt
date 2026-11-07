# A source keeps its upstream producing through an upkeep

[ADR 0020](./0020-a-source-gives-its-change-signals-and-a-failed-signal-fails-only-its-streams.md) took the watch loop out of each source: a source declares its change signals, and the pipeline reads them. One source did more in its loop than read gauges. Only Notes.app syncs iCloud notes on a Mac, and macOS closes a hidden Notes when it frees disk space. So the watch of the Notes source launched Notes hidden at its first check, and again at most each 30 seconds. The code said why: "Launching Notes is work between checks, not a read of the store" (elt `cf842f3b` moved it out of the read and into the loop). A change signal tells which streams changed; it has no place for an action.

## Decision

- An **upkeep** is an action that a source keeps doing while a watch runs, beside its change signals: `{ interval, run }`.
- A source that has one declares `upkeep(clock)`. The pipeline gives its clock, as for the change signals.
- The pipeline runs each upkeep when the watch starts, and then `interval` milliseconds after each run ends, until the watch stops. `run` gets the signal of the watch.
- A failed run is recorded one time for each run of failures, as a failed pass of the streams of the watch, with the failure type of the error. After a `system` failure the next run comes at the next interval; after a `config` failure the upkeep runs no more in this watch, as a gauge does after a `config` failure. The watch and its change signals continue.
- The Notes source declares one upkeep: launch Notes hidden each 30 seconds, when it does not run.

## Precedents

- **Debezium** runs `heartbeat.action.query` on the source database at each heartbeat, an action of the connector framework that keeps an upstream producing changes for the connector to see, apart from the reads of the changes.
- elt itself ran this action in the loop of the Notes source since `2ab585af`.

## Considered Options

- **The read of the Notes gauge launches Notes.** No new concept, but a read with an effect, which `cf842f3b` moved out of the read, and a launch must then fit the timeout of a read.
- **A change signal that names no stream, whose gauge launches Notes.** It uses the machinery of change signals for something that is not a change signal.
- **The host keeps Notes running.** Only the Notes source knows that Notes must run.
- **An upkeep beside the change signals.** This option was selected.

## Consequences

- `upkeep` is optional on a source: one source has an upkeep today.
- A launch that fails is visible in the sync history, and `current_as_of` of the Notes streams stays as of the last write of Notes, as before.
