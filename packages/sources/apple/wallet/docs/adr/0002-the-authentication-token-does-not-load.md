# The authentication token does not load

`pass.json` holds `authenticationToken`, the credential that the web service of the issuer takes to update or unregister the pass. A reader of the destination does not need it, and a copy of it in the destination is a risk.

Thus `authenticationToken` loads nowhere: `passJson` is the full `pass.json` without it. Barcode messages load, because the pass shows them for scanning and a reader needs them.

## Considered Options

- **Load the full `pass.json`.** The destination then holds the credential of each pass.
- **Leave out `authenticationToken` only.** This option was selected.

## Consequences

- On 2026-10-10, the token of none of the 4 passes was in any of the 38 files of the import.

Sources: commit 71692a43, backlog item 2422.
