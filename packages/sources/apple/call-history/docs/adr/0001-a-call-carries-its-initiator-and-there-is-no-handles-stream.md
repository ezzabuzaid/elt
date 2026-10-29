# A call carries its initiator, and there is no handles stream

The store keeps the parties of a call as rows of `ZHANDLE`. callhistoryd copies each handle for each call: on 2026-10-06, 3,448 handle rows held 500 different addresses, and no handle was on two calls. Thus a handle does not identify a person or a contact. It belongs to one call.

A handles stream would repeat each address once for each call, and its keys would be Core Data row numbers. Thus the source has no handles stream. `calls` carries the initiator of the call. `callParticipants` holds the other parties, keyed by the call, the handle type and the value.

## Considered Options

- **A handles stream, keyed by row number.** It copies the same address many times and has no stable key.
- **The initiator on the call, and the participants keyed by call.** This option was selected.

## Consequences

- A participant is a party to one call, not a contact. A reader joins participants to contacts by value.
- `ZHANDLE` rows that no call refers to do not load. They are the initiators of deleted calls, because the model clears the call from its initiator but does not delete the handle.

Sources: commit 0e07d451.
