# eca keeps no state across restarts

The first version of eca kept the matches of each rule in a SQLite store file. After a restart, a rule then took no new baseline, so the host did not hear of a key again, and it did not miss a key that started to match while it was down. The user decided that this is the concern of the host that uses eca, not of eca.

Thus eca keeps the keys of each rule in memory only. When the host starts again and adds its rules again, each rule takes a new baseline.

## Considered Options

- **eca keeps a store file.** eca then depends on SQLite, and it owns a concern that is the host's.
- **A port for the memory of eca, which the host fills.** This adds a port before a host needs it.
- **eca keeps the matches in memory.** This option was selected.

## Consequences

- eca has no store and no dependency on a database.
- A key that started to match while the host was down is in the baseline of the next start, and eca does not yield it.
- A host that must keep the keys across restarts cannot give them to eca yet. eca gets a way to accept them when the first such host needs it.
