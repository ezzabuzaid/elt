# The sidebar file is the whole sidebar

The sidebar file holds every space and every item that Arc shows now. When the user removes an item, Arc writes the file again without the item. Thus an item that is not in the file was removed.

## Considered Options

- **Never delete, as the Dia source does for its archive.** Dia removes archived tabs for reasons that it does not record. Arc's sidebar has no such removals: each removal is an act of the user.
- **Compare each read with the last snapshot under `ClosedWorld`.** This option was selected. A removed item, or a removed space, is deleted.

A pass reads the file one time, in `open`. Both streams use that read. Thus each `spaceId` of `sidebarItems` names a space of the same version of the file.

The file is about 2 MB with 900 items, and JSON must be parsed whole. Thus the SDK keeps the read as arrays, and a pass needs no heap test.

## Consequences

- A rerun with no change writes nothing.
- A file that the SDK cannot decode fails the pass with `ArcSidebarFormatError`, and the diff deletes nothing. An item kind that the SDK does not know also fails the pass. Arc is in maintenance, so its format is not expected to change. The error names the item and its kind.
- A missing file, or a file that the process cannot read, gives `ArcSidebarUnavailableError`, which is a configuration failure.
- Arc writes the file only while it runs. Thus the stream is current as of the last write of the file. A watch polls the file stamp (`FileStamp` of `@zukhruf/fs`) each second.

## Sources

The sidebar file of this Mac, probed on 2026-11-02. The tests in `src/arc-desktop.test.ts`.
