# A computed dataset keeps one output row for each key

The outputs of a rule must stay in step with the loaded rows. Rows can be new, they can change, and a commit can remove them. The rule can also change. elt has no feed of what each commit added or removed. A refresh can read the committed rows, and the outputs that it kept. This is level-triggered work: the refresh compares two states, and it does not count on events.

Thus a computed dataset keeps one output row for each key, in the table `raw_<name>`. A refresh reads the input of each loaded row of its `from` targets, and it compares the inputs with the output rows:

- It deletes each output row whose key no input has any more.
- It computes each key that is new, whose input hash or rule identity changed, or whose status is `failed`.
- It keeps each other output row.

A key that two loaded rows give keeps the first input. Thus one file in three chats is one output row. In Dagster, the same design uses dynamic partitions, with one partition for each file.

## Considered Options

- **Compute only what each commit added.** elt does not give that change, and a lost event loses an output.
- **A queue table of the work.** The queue then is a second copy of the same state.
- **One output row for each key, and a comparison at each refresh.** This option was selected.

## Consequences

- Each refresh reads each input and each output row. The cost grows with the rows, not with the change.
- An output row always shows the last input that the rule computed, with its rule identity.
