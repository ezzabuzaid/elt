# A host gives a rule back its keys

Superseded on 2026-11-13 (#4253) by [ADR 0010](./0010-eca-is-a-stateless-reader-over-warehouse-positions.md): keys tell only what matched at the last evaluation, so a key that stopped and matched again while the host was down was missed. The host now saves one cursor for each rule, and the walk from it reads each position that it missed.

The Context Compiler plugin is a host whose server stops when a chat closes or ChatGPT restarts. Its rule "when a new Careem receipt arrives, log the calories" must not miss a receipt. The server stops at 10:00. A receipt arrives at 11:00. The user syncs at 12:00, and a new server adds the rule again. With a new baseline, the 11:00 receipt is in the baseline, and the rule never yields it. The meal is not logged.

[ADR 0006](./0006-eca-keeps-no-state-across-restarts.md) kept eca without a store and said that eca gets a way to accept the keys when the first such host needs it. The plugin is that host.

## Decision

`add(rule, { keys })` starts the rule from the keys that the host gives, and it takes no baseline. `keys(rule)` gives the keys that the host saves. eca still keeps no store: the host saves the keys where it saves its own state.

`keys(rule)` holds a new match only after the host moved past it. Thus a host that acts on a new match and then saves the keys hears of the match again when it stops between the two steps. The user chose this order: a meal logged two times is better than a meal not logged.

## Considered Options

- **The host compares the matches with its saved keys, without eca.** Each host then repeats the comparison of keys that eca does, and its rules about a key that stops and matches again.
- **eca keeps a store file.** [ADR 0006](./0006-eca-keeps-no-state-across-restarts.md) rejected it.
- **`add` accepts the saved keys, and `keys` gives them.** This option was selected.

## Consequences

- A host that saves the keys misses no key across a restart.
- A host can act on a new match two times. Its action must accept that, or the host must tell a repeated new match by its key.
- A host that saves nothing gets a new baseline at each start, as before.
