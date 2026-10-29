# Clock reads its stores, not the MobileTimer services

A source must read all of the saved Clock objects, and see each change. The probe of 2026-10-11 (macOS 27.0, Clock 1.1) examined each way to read them:

- Clock has no scripting dictionary (`sdef` error -192).
- From a normal process, the reads of `MTAlarmManager`, `MTTimerManager` and `MTStopwatchManager` gave `NSCocoaErrorDomain` 4097 for their `mobiletimerd` services. Clock has a private `mobiletimerd` entitlement.
- The app intents operate on objects, but they do not give a full read of the data or its history.
- The MobileTimer database, the city preferences and the stopwatch preferences hold all saved objects, and a process with access can read them.

Thus the source reads the three stores directly, without writing. A watch reads a version probe of each store, so it needs no subscription to a private daemon.

## Considered Options

- **Read through the MobileTimer manager services.** A normal process cannot connect to them.
- **Read through scripting or app intents.** Clock has no scripting dictionary, and the intents give no full read.
- **Read the stores directly.** This option was selected.

## Consequences

- The source needs read access to protected files. On the examined Mac, a process outside the host with access could not read the database and the city preferences. It could read the stopwatch preferences.
- The source depends on the layout of the stores. A database without a column that the source reads fails with `MissingColumnsError`.
- The source gives what the stores keep: the current state, and no history that only the services could give.

## Sources

Commit 5b8c3bd1, which added the Clock reference section and the verification ledger `docs/apple-clock-verification.md` (removed in 626061cc when the app moved to Context Compiler). The ledger records the failed manager reads under "Verification limits".
