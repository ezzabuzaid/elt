# Arc source

A host wants the sidebar of the Arc browser in a store that SQL can read: the spaces, and the tabs, folders, notes and split views in them. Arc keeps the sidebar in one JSON file, the sidebar file. The Arc source reads that file, and it does not start Arc. The words that all of elt uses, for example stream, snapshot stream, checkpoint and pass, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Sidebar file**:
The file `Library/Application Support/Arc/StorableSidebar.json` in the home folder. It holds every space and every item, as Arc saved them last.
_Avoid_: Backup (Arc keeps dated copies, `StorableSidebar.<date>.json`, that the source does not read)

**Profile**:
A Chromium profile of Arc, named by its folder in `Library/Application Support/Arc/User Data`, for example `Default` or `Profile 2`. Arc's history and bookmarks for the profile are in that folder.
_Avoid_: Account, user

**Space**:
A named part of the sidebar with its own theme. Each space belongs to one profile.
_Avoid_: Workspace, tab group

**Item**:
One entry of the sidebar: a tab, a folder, a note or a split view.
_Avoid_: Bookmark, node

**Folder**:
An item that holds other items. Arc's file calls it a list.
_Avoid_: List

**Note**:
An Arc note. The sidebar file holds only its document ID. Arc keeps the text of the note in a different place.
_Avoid_: Document, easel

**Split view**:
An item that shows its tabs side by side. Its children are tabs.

**Section**:
Where an item is: the pinned part of its space, the unpinned part of its space, or the favorites of its profile. Every space of a profile shows the same favorites.
_Avoid_: Container (the file's own word for the root of a section)

**Container**:
The root of one section in the sidebar file. A container is not an item, and no row holds it.
