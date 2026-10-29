# Contacts reads its Core Data stores, not Contacts.framework

The source must read each contact on the Mac, also when a launchd job runs the pipeline. Contacts.framework needs the Contacts grant for the process. A `node` process that launchd starts cannot ask for that grant.

Contacts keeps its data in Core Data stores: `AddressBook-v22.abcddb` at the root of `~/Library/Application Support/AddressBook` for On My Mac, and one store for each account in `Sources/<id>/`. The source reads these stores in read-only mode. The Contacts grant or Full Disk Access gives access to them, and Contacts.app does not have to run. The framework also gives less than the stores hold.

## Considered Options

- **Contacts.framework.** It needs the Contacts grant itself, and it gives less than the stores hold.
- **The Core Data stores, read-only.** This option was selected.

## Consequences

- Each stored attribute of the `ABAddressBook` model loads, with the name that the model gives it. Relationships load as `uniqueId`s, which are the identifiers of Contacts.framework.
- The source must follow the layout of the stores. A store without a column or an entity that the source reads fails with `MissingColumnsError` or `ContactsSchemaError`.
- The stores do not name their accounts. `containers.name` is null until the source reads the Accounts store (#2037).
- On 2026-09-25, for all 414 contacts of the Mac, the values were the same as a non-unified Contacts.framework fetch.

## Sources

- b1576757: the Contacts connector. Contacts.framework is not used, because a launchd node cannot ask for its grant.
- #2037: name Contacts containers from the Accounts store (open).
