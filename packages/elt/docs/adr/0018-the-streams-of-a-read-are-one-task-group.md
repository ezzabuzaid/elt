# The streams of a read are one task group

A source that reads two streams at once (`concurrency`) can have a stream that waits for another, such as the routes stream of a web stream, which takes each group of routes that the web stream committed. When a stream throws outside its extract, for example because its saved state does not parse, `interleave` waits for every other stream to settle before the read rejects. A stream that waits for the stream that threw then never settles, and the read never ends.

Thus the streams of one read are one task group, as in Python's `asyncio.TaskGroup`: the first child that fails cancels the others ([taskgroups.py](https://github.com/python/cpython/blob/65665a4aba51b4718085eae25849dd4a15a4a295/Lib/asyncio/taskgroups.py#L260-L319)). `Source.read` gives `open` and each extract a signal that aborts when the run's signal aborts or when a stream of the read throws. The read rejects with the error of that stream, as before.

## Considered Options

- **`interleave` does not wait for the other streams.** A stream could then still run after its read ended and its context was disposed.
- **Each source that has dependent streams finds out when its other streams end.** A source sees only its extracts, not the throw that comes before an extract.
- **The streams of a read are one task group.** This option was selected.

## Consequences

- An extract gets a signal also when the run has none.
- The test `a stream that fails outside its extract ends the read, also while another stream of the read waits for it` of `elt` proves this rule.
