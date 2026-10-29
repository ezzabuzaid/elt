# Apple Books

A user wants the data of Apple Books in one store that SQL can read: the books, the highlights, and the time that they read. Books gives no API for this data. The Books source reads the stores that Books and `bookdatastored` keep on this Mac. The words that all of elt uses, for example source, stream and watch, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Store**:
One place where Books or `bookdatastored` keeps data: a Core Data database, or the two preference files that hold the reading goal. The source opens only the stores that the selected streams read.
_Avoid_: Database (the preferences store is two property list files), library (the library is one store)

**Asset**:
One item in the library of this Mac: a book, a PDF, an audiobook or a series. `assetId` identifies it.
_Avoid_: Book (a PDF and a series are assets too), title

**Annotation**:
A highlight, an underline, the reading position of a book, or a deletion marker that is not synced yet.
_Avoid_: Highlight (a highlight is one kind of annotation), note

**Reading history**:
The CRDT document that holds the seconds of reading for each day, the month totals and the streak records.
_Avoid_: Reading sessions (Books purges its sessions), activity

**Placeholder**:
A file in iCloud Drive whose bytes are not on this Mac. macOS downloads it when a process reads it. The flag `SF_DATALESS` marks it.
_Avoid_: Stub, offline file

**EPUB package**:
A book that Books keeps as a directory of files. The source loads it as one `.epub` file.
_Avoid_: Bundle, folder
