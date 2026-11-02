# An archived tab stays after Dia removes it

Dia removes an archived tab from the archive in three cases: the tab is older than an age, the user restores the tab, or the user deletes the tab. The archive records none of these. The archive on this Mac held tabs from about the last 60 days on 2026-11-02.

Thus the source cannot tell a deletion by the user from a removal for age. A snapshot stream that deletes each key that is gone would delete the user's old tabs after 60 days.

## Considered Options

- **Delete each tab that is gone (`ClosedWorld`).** This deletes the tabs that Dia removed for age. The user loses the history that the import keeps.
- **Delete only the tabs that are younger than the age (`Retention`).** Dia publishes no age, and a restore or a delete of a young tab is still not a deletion that the archive records.
- **Never delete.** The stream declares no `emitsDeletes`, and the snapshot diff gets no policy. This option was selected. The Notification Center source does the same for its notifications.

## Consequences

- The `archivedTabs` table keeps each tab that a pass loaded.
- A tab that the user restored or deleted stays in the table.
- A change of a tab that is still in the archive, for example a new title, is written again.

## Sources

The `add-elt-source` skill, "Sync strategy", rule 3. The Notification Center source of elt.
