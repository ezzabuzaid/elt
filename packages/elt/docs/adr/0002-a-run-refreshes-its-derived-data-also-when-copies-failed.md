# A run refreshes its derived data also when copies failed

Some connections fail some copies at each run. For example, a WhatsApp or Safari store that is not on the Mac fails the streams that read it, and the other streams load. If a run refreshed its derived data only after a run with no failures, the stored files of that connection never get their text. The host before this change also read the text after a run that failed.

Thus `run()` refreshes each derived dataset after the passes of all connections, also when some copies failed. Then it rejects with `PipelineError`, which tells each copy that failed. A derived dataset reads what the copies committed. A copy that failed keeps its last committed rows, so the derived data of those rows stays as it was.

The pipeline refreshes the derived datasets one after the other, in the order of the list. Thus a view that comes after a computed dataset can read the view of that dataset.

A run does not refresh after an abort, or after an error that no sync history recorded. A stop that comes after the passes ended only stops the refresh. The run then ends as its passes did, and the next refresh continues the work.

## Considered Options

- **Refresh only after a run with no failures.** A connection that always fails one copy then never gets derived data.
- **Refresh after the passes, also when copies failed.** This option was selected.

## Consequences

- A host gets the derived data and the copy failures from the same run.
- The test `a run whose other copy failed still stores the text of the files its loaded rows name, and then rejects with that copy’s failure` of `elt-sqlite` proves this rule.
