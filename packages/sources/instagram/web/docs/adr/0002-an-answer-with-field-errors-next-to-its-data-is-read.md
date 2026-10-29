# An answer with field errors next to its data is read

From 2026-10-15, every live sync stopped the grid of @hivefitnationgym at page 5 with "A server error field_exception occured" (backlog #2643). A replay from the signed-in web client, with the exact request of the SDK, got the same answer. Thus the request of Node was not the cause. Pages 5 and 6 sent all 33 posts in `data`, and also `errors` whose path names the `location.profile_pic_url` of a post. Instagram set that field to null.

These are GraphQL field errors: a partial response, not a refused query. Relay, the client of instagram.com, shows such data.

Thus the SDK refuses only an answer that has errors and no data, for example "Incorrect Query". It gives an answer with errors next to its data to the schema of the answer. The schema refuses the answer only when the SDK reads the field that has the error, and it names that field.

## Considered Options

- **Refuse each answer that has an `errors` entry.** The grid then stops at the first page with a field error, also when the SDK does not read that field.
- **Read the data, and refuse the answer only when a field that the SDK reads has an error.** This option was selected.

## Consequences

- Hive's grid loads past page 5.
- The SDK does not read the picture of a tagged place, because Instagram answers it with field errors.
- A field error on a field that the SDK reads fails the stream, with the name of that field.

## Sources

- Commit 3a1d8ad3, backlog #2643.
