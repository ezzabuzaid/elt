# Dia source

A host wants the tabs that the Dia browser archived in a store that SQL can read. Dia closes a tab that the user did not use for some time and keeps it in its archive. The Dia source reads that archive file. It does not start Dia, and it needs no Full Disk Access. The words that all of elt uses, for example stream, snapshot stream, checkpoint and pass, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Archive**:
The file `StorableAutoArchive.json` in `~/Library/Application Support/Dia`. Dia writes the whole file again while it runs. It holds one list of archived tabs for each profile.
_Avoid_: History (the browser history is a different store), auto archive

**Archived tab**:
A tab that Dia closed and keeps in the archive. Dia removes it after an age, when the user restores it, or when the user deletes it.
_Avoid_: Closed tab (Dia also closes tabs that it does not archive)

**Profile**:
A Chromium profile of Dia, named by its folder, for example `Default` or `Profile 1`. The archive names it in `id.profile._0` of each container. An import scope selects profiles by these names.
_Avoid_: Account, container (the container is the JSON object that holds one profile's list)

**Variant**:
What the tab showed: `webContent` for a web page, or `supertab` for a Dia supertab. Dia keeps it as a JSON object with one key, the case.
_Avoid_: Type

**Space**:
The Dia space that held the tab, named by a UUID.
_Avoid_: Workspace

**Stamp**:
The file stamp of the archive (`FileStamp` from `@zukhruf/fs`): the device, inode, size and times of the file. A watch reads it each second, and a change of it is a write of the archive.
_Avoid_: Version, fingerprint
