# Code copied from the hop of source-microsoft-sql-server

A test of this package must see what a query does when SQL Server never acknowledges its cancel. The SQL Server of the tests always acknowledges one, so the test puts a TCP hop between the driver and the server, and the hop stops forwarding what the server sends. `@eltjs/source-microsoft-sql-server` already has such a hop for its tests: `relay` in `sql-server-source.test.ts`. This package keeps its own copy in `sql-server-request.test.ts`, because packages export no shared test modules (AGENTS.md).

The reason is the Rule of Three. It counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. The boundary of the shared code then comes from three working copies, not from a guess. When a third test file needs a hop, the shared parts move to one place (backlog #5655). Until then, a fix in one copy is made in the other copy too, and the commit names both files. This note is the input for that step.

Paths on the left are in `packages/sources/microsoft/sql-server/src`. Paths on the right are in `packages/sdks/microsoft/sql-server/src`.

## Copied without a change

These rules are the same in both copies:

- Each connection of a client gets its own connection to the server, and the hop pipes the two both ways. An error on one side destroys the other side, and so does a close.
- `stallAfter(bytes)` counts what the server sends. When the count is reached, the hop unpipes and pauses every open connection to the server, so it holds what the server sends after that while both sockets stay open. A connection that opens later is forwarded.
- The hop listens on a random port of 127.0.0.1. Its dispose destroys every socket and closes the server.

## Copied with changes

**`sql-server-source.test.ts` `relay` → `sql-server-request.test.ts` `relay`.**

- Not copied: `reachable`, `answering`, `held`, `received` and `resume()`.
  Why: these tests need no refused or unanswered connection, and nothing goes on after a stall. The copy counts what the client sends (`sent`) instead, to know when a request reached the server.
- `stallAfter` settles with `sent` as it was at the stall.
  Why: the driver runs in the same process as the test. It can send its next request right after the forwarded chunk, before the test reads the count.
- The listener that stalls is added after the pipe, so the chunk that reaches the count goes to the client. In the source copy that listener is added before the pipe.
  Why: the forwarding of that chunk then does not depend on the order in which Node calls the listeners of one event. The pool checks a connection with a `SELECT 1` that takes no signal and waits up to 30 seconds, so a test that stalls after that check needs its answer forwarded.
- The hop gives `port`, not `server` (`127.0.0.1,<port>`).
  Why: these tests make the `SqlServerDatabase` from parts, not from a connection string.
