# Apple Activity

A user wants to know what they did on their devices: which apps had focus, which pages they used, when a Focus was on. macOS records this activity for about one month, and then drops it with no deletion. The Activity source reads these records on this Mac and keeps their rows after macOS drops them. The words that all of elt uses, for example source, stream, group and watch, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Biome stream**:
One kind of record that Biome keeps, for example `App.InFocus`, in its own folder under `~/Library/Biome/streams/restricted`.
_Avoid_: Stream (a stream of elt is what a copy reads; most streams of this source read one Biome stream), event log

**Segment**:
One preallocated SEGB v2 file of a Biome stream. Biome writes records into it in place and never compacts it. The source diffs each segment as one group.
_Avoid_: File, chunk, page

**Slot**:
One 16-byte entry in the trailer of a segment. It gives the end offset, the state and the write time of one record.
_Avoid_: Row, index

**Origin**:
The device that wrote a record: `local` for this Mac, or the identifier of a synced device.
_Avoid_: Device (the `devices` stream lists devices), source

**Maximum age**:
The time that macOS keeps the records of a stream, as the BiomeLibrary of macOS compiles it: 28 days for most streams. A record older than its maximum age expires.
_Avoid_: Retention (the deletion policy `Retention` uses it), TTL

**Tombstone**:
An entry in the deletion log of Biome, in the `tombstone/` folder of a Biome stream. It gives the reason for a deletion.
_Avoid_: Deletion marker

**Session**:
The time from a start record to its end record. A preset of Context Compiler makes it; the source loads the two records only.
_Avoid_: Visit (a web visit is one kind of session), span
