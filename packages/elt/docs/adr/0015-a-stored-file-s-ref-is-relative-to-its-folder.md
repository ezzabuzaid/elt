# A stored file's ref is relative to its folder

`LocalFiles` returned the absolute path of each stored file, and that path loaded into the ref column, for example `attachmentRef`. Its identity, which is part of the checkpoint binding of each copy that stores files, named its absolute folder. An Apple import that moved to a different disk or home folder then refused its checkpoints, its rows pointed into the old folder, and the text rule could read none of the files.

Thus `LocalFiles.save` returns `.elt-files/<scope hash>/<content hash><extension>`, relative to its folder. `retain` compares those refs, and the identity is `{type: 'local-files'}`. The rule that reads the text of the stored files takes the folder of the files and opens each ref in it. `raw_attachment_text.ref` keeps the relative value, so readers still join `attachment_text.ref = attachmentRef`.

## Considered Options

- **An absolute path, and an identity that names the folder.** A moved import loses its checkpoints and its files.
- **A path relative to the folder of the storage, and an identity with no folder.** This option was selected.

## Consequences

- An import that moves with its files keeps each ref and each checkpoint.
- A reader opens a ref inside the folder of the files, beside the database of the connector.
- This is the same rule as for targets: a stored object is named by its address inside its store (ADR 0009).

Sources: elt 1c9d262e.
