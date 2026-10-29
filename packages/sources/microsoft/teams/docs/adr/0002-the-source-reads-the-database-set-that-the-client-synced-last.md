# The source reads the database set that the client synced last

When the app language of Teams changes, the web client starts a new database set for each account (`…:en-gb` next to `…:en-us`). It leaves the old set on disk, with what it had cached. Two sets of one account then hold different parts of the same history. The app setting does not name the set that the client uses: after the probe set the language to follow macOS, `app_settings.json` said `en-jo`, while the client still wrote the `en-us` databases.

Thus the source reads only the database set that the client synced last, by the newest `lastSyncTime` among the sync states of each set.

## Considered Options

- **Read the set that the app setting names.** The setting can name a locale that has no set.
- **Read the set with the newest sync time.** This option was selected.

## Consequences

- After a change of the app language, the source follows the new cache. A change back makes the old set current again, and the source reads it again.
- Rows that the import loaded before the change stay.
- The first import after a change does not read history that only the old set holds.

## Sources

- Commit c0694480: "When the app's language changes, the client starts a new database set and leaves the old one; the source reads the set synced last." The live check of 2026-10-12 followed a language switch and back.
