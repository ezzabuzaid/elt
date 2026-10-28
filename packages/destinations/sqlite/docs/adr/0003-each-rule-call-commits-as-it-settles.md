# Each rule call commits as it settles

A refresh first gave its inputs to the rule in batches, and it committed a batch only when all of its inputs settled. One file that was slow to parse then held back the text of each file in its batch, and each batch after it. This is head-of-line blocking. A test of Context Compiler with one slow file found it.

Thus a rule tells two numbers. `batch` is how many inputs one call of `compute` takes. `concurrency` is how many calls run at the same time. The computed dataset runs that many calls. Each call takes the next batch when its own batch committed, as a worker pool keeps its other workers busy. Each call commits in its own transaction. A call that throws stops the pool, and it is a dataset failure.

`DocumentText` reads one file in each call, with one call for each core of the Mac. `Embedding` sends 64 texts in each call, with one call at a time.

## Considered Options

- **One transaction for the whole refresh.** Readers then see no output until the last input settles.
- **One batch at a time, committed when all of it settled.** One slow input then holds back all inputs after it.
- **A pool of calls, and each call commits as it settles.** This option was selected.

## Consequences

- Readers see the output rows as they land.
- A slow input holds back only its own place.
- A stop keeps the output rows that committed. The next refresh computes the others.
- The test `a file that is slow to read holds only its own place` proves this rule.
