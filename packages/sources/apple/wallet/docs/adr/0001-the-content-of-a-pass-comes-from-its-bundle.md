# The content of a pass comes from its bundle

passd keeps the metadata of each pass in `passes23.sqlite`, and copies some of its content (`relevant_pass_dates`, `location`). The fields, the barcodes and the localizations are only in the bundle. The copies of passd also lose the offset of each date: `pass.json` writes a departure as `2025-09-15T09:30+08:00`, and the database keeps only the time.

Thus the source reads the content of a pass from the bundle: its signed `manifest.json`, `pass.json` and each `<language>.lproj/pass.strings`. It reads only the dates of passd itself (added, updated, archived) and the sorting state from the database. Each date of `pass.json` loads as a UTC time and its offset in minutes. Numbers keep their source text, so a value that a double cannot hold keeps every digit.

## Considered Options

- **Read the copies of passd.** They lose the offsets and have no fields.
- **Read the bundle.** This option was selected.

## Consequences

- A date without a time zone fails the read.
- A pass whose bundle is missing, or whose `pass.json` cannot be decoded, fails with `PassBundleError`. The source does not leave the pass out, because a pass left out would delete its rows.
- passd commits through a rollback journal, and a held read stops its commits. Thus the SDK reads the rows of passd in one read transaction and closes the database before it reads the bundles.

Sources: commit 71692a43, backlog item 2422.
