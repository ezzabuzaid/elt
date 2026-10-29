# chat.db is read as a snapshot

Messages changes old rows of `chat.db`. An edit, an unsend and a read receipt change a message after it is sent. A cursor needs a column that increases at each change, and `chat.db` has none. macOS 27 added `message.date_updated`, but each value of the verified history is 0 or NULL. Thus that column does not give a modification time.

Thus the 13 streams are snapshot streams. Each run reads all rows of `chat.db` in one read transaction. The snapshot diff loads the rows that changed and deletes the rows that disappeared. A second run with no changes writes nothing.

## Considered Options

- **A cursor on a message date.** An edit or a read receipt does not change `date`, so the cursor does not see it.
- **A cursor on `date_updated`.** The column is 0 or NULL on each row.
- **A snapshot of all rows at each run.** This option was selected.

## Consequences

- Each run reads the full history. On the verified history of 12,567 messages, all streams loaded in approximately 1 s without attachment parsing.
- The snapshot state holds a fingerprint for each key. It was approximately 2.6 MB of JSON for that history.
- A message that Messages removes from a chat is deleted from `chatMessages`. Recently Deleted keeps it in `recoverableMessages`.

## Sources

- 8afb65ef: the Messages connector, with 13 snapshot streams, and its live check on 2026-09-25.
- 8c5c2567: the twelve macOS 27 columns. `date_updated` is new, but it holds no modification time.
