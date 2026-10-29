# A book file is copied only when its bytes are on this Mac

Most books are in iCloud Drive as placeholders. When a process reads a placeholder, or lists a placeholder that is a directory, macOS downloads it. `Books.plist` lists the books that are local, but its flags are wrong: on 2026-10-01 it listed 13 books as local, and 10 of them were placeholders.

Thus the reader reads the flag `SF_DATALESS` of each item with `/usr/bin/stat` before it reads or lists the item. The `stat` of Node.js does not give BSD flags. A book with one placeholder item has `availableLocally: false` and no file.

An EPUB package is a directory. The source stages it as one OCF `.epub` file, as Mail stages its attachments: the record carries the path of the staged file, and the destination stores the file. `mimetype` is the first entry and is stored without compression, the entries are in name order, and the timestamps are fixed. Thus a package that did not change gives the same bytes and keeps its copy. This needed no change in elt: Contacts photos and the file transfer of Airbyte stage files in the same way.

## Considered Options

- **Use the local flags of `Books.plist`.** They are wrong.
- **Read each file.** This downloads every book from iCloud.
- **Read the flags with `/usr/bin/stat`, and read only local items.** This option was selected.

## Consequences

- A load does not download a book, and it changes no flag.
- A book that macOS downloads does not change a Books store. Thus a watch does not see it, and the next library change or run loads it (backlog item 2128).

Sources: commit 5dcd0609; backlog item 2128.
