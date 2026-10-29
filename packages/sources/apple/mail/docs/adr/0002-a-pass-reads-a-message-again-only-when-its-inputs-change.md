# A pass reads a message again only when its inputs change

A pass with no Mail changes parsed each message file again in four streams. On a store of 25,689 messages, that pass took 59.2 s of its about 81 s in `messageParts` (29.3 s), `messageHeaders` (14.8 s), `attachments` (9.3 s) and `messageFiles` (5.8 s), measured for each stream through `Source.read` with no destination.

Thus these four streams are grouped snapshots, with one message group for each selected message. The fingerprint of a group includes a parser version, the message file, each detached file and the rows of the message in the attachment index. [ADR 0003](./0003-a-fingerprint-keeps-only-what-a-copy-of-the-store-keeps.md) tells which values of a file it includes. A message whose fingerprint did not change keeps its rows, and the pass does not read it. A new or changed message is parsed.

The selection runs on each pass. A message that leaves the scope has no group, and its rows are deleted. The index-only rows of `attachments` are in the group of their message. A message that the index lists but the scan does not list has its own group. Thus a kept message cannot give its rows two times.

## Considered Options

- **Parse each message file on each pass.** A quiet pass then takes about one minute.
- **Keep one group for each message, with a fingerprint of its inputs.** This option was selected.

## Consequences

- After the change, each of the four streams took 0.6 s in the same measurement: the store open (about 0.4 s) and the fingerprints. 59.2 s became 2.4 s.
- The state of `messageHeaders` grew from 57.7 MB to 59.8 MB. Its JSON round trip stayed 0.5 s.
- When parsing or the records of these streams change, increase `messageParserVersion`, and each message is read again.

## Sources

Commit 1b0a3567.
