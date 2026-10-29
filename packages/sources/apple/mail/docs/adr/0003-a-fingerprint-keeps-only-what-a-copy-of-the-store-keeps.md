# A fingerprint keeps only what a copy of the store keeps

The fingerprint of a message group included the full version of each file: device, inode, size, and modification and change times. A copy of the Mail store changes the device, the inode and the change time. Migration Assistant to a new Mac, a restore and an APFS clone make such copies. After a copy, each message looked changed, and the next pass read all of Mail again. That took about as long as the first import.

Thus the fingerprint includes only the size and the modification time in nanoseconds of each file, with its path relative to the version folder. A copy keeps these values. rsync's quick check and git's `core.checkStat=minimal` compare files in the same way. The full file version stays for the check around each read, which fails the read when Mail changes the file during it. There the change time sees a rewrite within one tick of the modification time.

## Considered Options

- **The fingerprint includes the full file version.** A copied store is then read again in full.
- **The fingerprint includes the relative path, the size and the modification time.** This option was selected.

## Consequences

- A copied or moved Mail store keeps the identity of each message that did not change, and the next pass reads none of them again.
- A rewrite with the same size and the same modification time in nanoseconds is not seen between passes.
- The identity of the source names no folder (`apple-mail`), so a copied store also keeps its checkpoints.

## Sources

Commits 9f02892f (the fingerprint) and df71b90d (the identity names no folder). Backlog #2804 (a copied or moved store keeps each import), parts 4 and 5.
