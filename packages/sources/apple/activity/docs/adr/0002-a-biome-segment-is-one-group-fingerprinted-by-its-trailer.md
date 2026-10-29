# A Biome segment is one group, fingerprinted by its trailer

Biome writes into preallocated segment files in place. It does not change the size of a file, and the modification time was up to 236 hours older than the newest record. The deletion counter in the header did not agree with the deleted slots in 9 of 417 files. FSEvents reports nothing for these writes.

The trailer of a segment changes with each record that Biome writes or deletes, because each slot holds the state and the write time of its record. Thus each segment is one snapshot group, and the hash of its trailer is the fingerprint of the group. A run reads again only the segments whose trailer changed. A watch polls the list of segments and the trailer hashes. The fingerprint also carries a decoding version, so a change of the decoding reads every segment again.

## Considered Options

- **Use the size and the modification time.** They do not change when Biome writes.
- **Use the deletion counter of the header.** It is wrong in some files.
- **Use FSEvents.** It reports nothing.
- **Hash the trailer of each segment.** This option was selected.

## Consequences

- A run with no new records reads only the trailers: 0.7 s on this Mac, against 4.4 s for the first load.
- `(origin, segment, slot)` identifies a record, because Biome never compacts a segment.
- A watch polls every minute. App focus records come with each switch between apps, so one minute collects them into one pass.

Sources: commit f9cc0a57 (the Activity source), commit 7504f191 (the SDK `sdk-apple-biome` and the codec `codec-segb`).
