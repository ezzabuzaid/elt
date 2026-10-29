# The display order of Wallet does not load

`pass_group.group_order` is the order in which Wallet shows the passes. When a pass is added, passd gives it order 0 and moves the order of every other pass by one (seen live on 2026-10-10). If `passes` loaded this order, each add would change every pass, and a run would write every pass again.

Thus the source does not read `pass_group`.

## Considered Options

- **Load `group_order` on `passes`.** Each add writes every pass again.
- **Leave out the display order.** This option was selected.

## Consequences

- A run after an add writes only the new pass and its records.
- A reader cannot get the order of the Wallet stack. `sortingState` still tells current passes from expired ones.

Sources: commit 71692a43.
