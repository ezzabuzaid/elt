# A notification keeps its row after the store forgets it

Notification Center keeps a notification only until its app withdraws it, the user clears it, a newer one replaces it, or it expires. usernoted then deletes the row, and it keeps no record of why. A snapshot diff that deletes each record that leaves the store would make the destination only a copy of the last minutes.

Thus `notifications` declares no `emitsDeletes`. The snapshot diffs of elt leave such a stream alone: a key that leaves the store keeps its row and leaves the state. Airbyte keeps the rows of a source that cannot emit deletions in the same way. elt calls this a forgetting upstream.

`apps`, `categories` and `categoryActions` describe the store now. They declare `emitsDeletes` and delete what leaves the store.

## Considered Options

- **Delete each notification that leaves the store.** The destination then holds only what Notification Center shows now.
- **Keep each notification that the source saw.** This option was selected.

## Consequences

- The rows of `notifications` are a history. A notification that the user cleared stays too.
- A watch must poll often, because many notifications stay only some minutes. It polls `data_version` every second.

Sources: commit ec286f9b.
