# An item finds its space through its section

An import can select profiles (`ImportScope.collectionIds`). Thus each item must have a profile. The sidebar file does not write a profile or a space on an item. It writes only `parentID`, the item or the container that holds the item.

In the sidebar file, each section has a container. A container of a space names its space (`containerType.spaceItems._0`). The space names its profile (`profile`), and its `containerIDs` tell which of its two containers is pinned and which is unpinned. A container of favorites names its profile directly (`containerType.topApps._0`), and it has no space.

The SDK walks each container through `childrenIds`, the order that Arc shows. Each item gets the profile, the space and the section of its container, a `parentId` and a `position`.

## Considered Options

- **Keep containers as rows, with a kind `container`.** A reader must then join to a row that the user never sees to find a space, and the root rows have no profile of their own.
- **Give each item its section, its space and its profile, and keep containers out of the rows.** This option was selected. An item at the top of its section has `parentId` null and its position in the section.

## Consequences

- A favorite has `spaceId` null and section `favorites`. Its profile comes from its container. A profile can have favorites and no space (seen on 2026-11-02: `Profile 2`).
- `spaces` has no container IDs. The section of an item holds the same fact.
- When a container does not name a known space, or a space does not list its container, the read fails with `ArcSidebarFormatError`. An item that no container reaches also fails the read. Thus no item has an unknown profile.

## Sources

The sidebar file of this Mac, probed on 2026-11-02 (Arc not used since 2025-08, file last written 2026-01-01): 9 spaces, 20 containers (two for each space, and favorites for two profiles), 881 items, no item outside a container.
