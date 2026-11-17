# A list whose delta Graph refuses is read in full

On 2026-11-17, Graph answered the item delta of the hidden list with the template `accessRequest` of the probed site with 503 `serviceNotAvailable` on each try. `GET /sites/{id}/lists/{id}/items?$expand=fields` of the same list answered 200. The item delta of each other list answered with a delta link. Thus a `listItems` read that asks for the delta of this list fails the site on each pass.

Thus the source routes each list by its template:

- `listItems` reads the delta of each list whose template is not `accessRequest`.
- `accessRequests` reads the items of each list whose template is `accessRequest` in full, with `listItems(siteId, listId)` of the SDK, on each pass. An incremental copy compares each read with its snapshot and deletes the items that Graph no longer lists (`ClosedWorld`).
- The two streams have the same fields.

## Considered Options

- **More retries of the delta.** The 503 did not go away. A retry loop holds the pass and fails it at the end.
- **Leave the list out.** The requests of people for access to the site would be lost with no error.
- **Read the list in full inside `listItems`.** One stream would mix a delta and a snapshot. The snapshot needs the keys of its items in the checkpoint to delete, and a delta stream keeps no keys.
- **A snapshot stream of its own.** This option was selected.

## Consequences

- An access request list is read in full on each pass. Such a list is small.
- The routing is by the template, a fact of the list, not by a failure of a read. A new template that Graph also refuses fails `listItems` until the source routes it.
