# A re-read day loses the rows that Google no longer returns

Google can restate the last days. Thus the source reads each day again from the last settled day. Before this decision, the dated copies upserted by date and never deleted. When Google stopped reporting a query for a re-read day, its row stayed. The marts hid it only when the same day got a newer row. A day that came back with no query rows showed old rows, and the totals had no filter at all (#2016, 11a18b1c).

The backlog item #2016 proposed a fix in the marts only: compare with the load time of the re-read window. Ezz chose a different fix (option B). `diffSnapshot` of elt got `keeps`, the records that the next read reads again. Only those records stay in the saved snapshot, and a record outside them is never deleted. Each dated grain of Search Console compares each read with the previous read, and it keeps the days from the first day of the next read (11a18b1c).

Airbyte's Search Console source reads only final data and never deletes. dlt's `delete-insert` replaces each day that a load brings, but it keeps a day that comes back empty (11a18b1c).

## Considered Options

- **Upsert by date, and filter in the marts.** A day that comes back empty keeps its old rows, and each reader must apply the filter.
- **Delete-insert for each day that a load brings.** A day that comes back empty keeps its old rows.
- **A snapshot diff that keeps the days that the next read reads again.** This option was selected.

## Consequences

- When Google does not give a row again for a re-read day, the source deletes it. When a re-read day comes back empty, the source deletes all rows of the day.
- A row that did not change is not written again.
- The days before the window stay as loaded.
- The checkpoint is `{ date, diff }`.
- The reader views read the raw tables with no filter on the latest load.
- In the same change, 9b7914c5 made `today()` the Pacific day (#2016).

Sources: commits 11a18b1c and 9b7914c5; backlog #2016.
