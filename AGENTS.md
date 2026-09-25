# Agent rules

## Stored data is disposable

Every destination table, Markdown export, and checkpoint can be rebuilt by rerunning the pipeline from scratch. Treat that data as cheap.

- Never design around data that is already stored: no backward-compatible schemas, no keeping checkpoint bindings stable, no migration paths, no compatibility shims or defaults left `undefined` for old state.
- Change schemas, identities, bindings, and defaults whenever the design improves; the fix for old output is a fresh run.
- Do not document migrations between connector versions. Document the current behavior only.

## Separate the concept from the mechanism

When asked why a notion exists, name the requirement it serves, not the code that currently needs it. A line such as `DELETE FROM` shows how a writer overreaches today; it does not make the mode, flag, or field that triggers it a necessary concept. Before relocating or keeping a notion, check whether it is an input to a smaller notion that is the real one.

## Exhaust live verification before calling something unverified

When a live probe finds no instance of a feature, widen it before concluding: scan the full history, not a sample window, and use any earlier evidence that the data exists. Mark behavior unverified only when the environment genuinely cannot produce it, and say what blocked it.
