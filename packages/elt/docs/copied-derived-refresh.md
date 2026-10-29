# Code copied inside elt: the refresh of the derived datasets

A run and a watch both bring the derived datasets in step with what the copies committed. Each keeps its own copy of that refresh, and the copies are not shared yet.

The reason is the Rule of Three. It counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. The boundary of the shared code then comes from three working copies, not from a guess. A third place that refreshes the derived datasets is the trigger. When it comes, the refresh moves to one place (backlog #3307). Until then, a fix in one copy is made in the other copy too, and the commit names both files.

## Copied with changes

**`Pipeline.run` in `src/core/pipeline.ts` → the refresh loop of `DerivedRefreshes` in `src/core/derived-refreshes.ts`.**

- Both refresh each derived dataset in its declared order and give it the pipeline's connections, the datasets before it (`earlier`) and the signal.
- `Pipeline.run` refreshes once, after the passes, and a dataset's failure rejects the run.
- `DerivedRefreshes` refreshes in the background, again while a pass asked for one more, and its first failure stops the watch.

Why: a run waits for its refresh; a watch must not hold a pass back while one runs.
