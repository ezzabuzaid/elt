# Each list is scanned in parts over runs

A profile's grid can hold thousands of posts. @propertyplus.jo has 3,479. Instagram rate-limits a session that asks for too many pages, and a rate limit stops the run. A run that must read a full list before it commits loses all its pages at a rate limit, and the next run starts again from the top.

Thus each run reads a maximum of 10 pages of each list of each profile. Each page is one part of a scan. A part loads its records at once and deletes nothing. The state keeps the keys that the parts listed while the scan is open. The part that gets to the end of the list deletes each key that no part listed. Each run first reads the list from the top, down to the newest item that the last run found, so a new post loads at the next run. Then it continues the open scan.

Airbyte's resumable full refresh keeps its page token only within one job. Thus no Airbyte scan continues over syncs that succeed. The snapshot differential adds this with `continues: true` (its ADR 0002).

The first `highlight_items` stream was one snapshot that committed at its end. On 2026-10-15, one failed download of about 800 lost the full first load, and the next run would start the 800 downloads again. Each page that Instagram answers for highlight items is now one part, and it commits with its images. Airbyte commits a checkpoint for each stream slice in the same way.

## Considered Options

- **Read each list fully in each run.** A rate limit or a failed download then loses the full read.
- **Read a maximum of 10 pages in each run, and continue the scan in the next run.** This option was selected.

## Consequences

- A long profile is complete after many runs: 3,479 posts take 11 runs.
- The source sees a deletion only when a scan ends.
- A rate limit stops the run, and the next run continues after the last committed page.
- A failed download of a highlight image loses only its page. The next run does not download again the images that loaded.

## Sources

- Commit d5543602: the Instagram source, with each list scanned in parts over hourly runs, and `continues` in the snapshot differential.
- Commit 114d6b2c: highlight items commit page by page.
