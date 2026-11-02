# A pass reads the whole archive into memory

The `add-elt-source` skill tells a source to hold one record at a time, and to prove it with a heap test of about 60,000 rows. The archive is one JSON document. A JSON parser that reads one record at a time is a new dependency.

The archive keeps only the tabs of about the last 60 days. On 2026-11-02 it was 1.48 MB with about 2,460 tabs. Thus the memory of a pass stays small.

## Considered Options

- **A streaming JSON parser.** This adds a dependency to save about 2 MB.
- **`JSON.parse` of the whole file.** This option was selected.

## Consequences

- The source has no heap test.
- If Dia keeps archived tabs for much longer, the archive grows, and the reads must stream.
