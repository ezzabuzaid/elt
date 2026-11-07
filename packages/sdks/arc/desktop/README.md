# @workspace/sdk-arc-desktop

Reads the sidebar of the Arc browser from its sidebar file, `Library/Application Support/Arc/StorableSidebar.json` in a home folder. It gives typed spaces and items, typed errors and a change signal. It does not write, it does not start Arc, and it does not use the network.

The words have the meanings of the glossary of [source-arc-desktop](../../../sources/arc/desktop/CONTEXT.md). The decisions are in its [docs/adr](../../../sources/arc/desktop/docs/adr).

```ts
import { homedir } from 'node:os';

import { ArcSidebar } from '@workspace/sdk-arc-desktop';

const sidebar = new ArcSidebar(homedir());
const { spaces, items } = await sidebar.read();
console.log(spaces.length, items.filter(({ kind }) => kind === 'tab').length);
```

- `read()` gives `{ spaces, items }`. A space has its `position` in the sidebar, its `profile` and its `customInfo` as JSON. An item is an `ArcTab`, an `ArcFolder`, an `ArcNote` or an `ArcSplitView`, by `kind`. Each item has its `profile`, its `spaceId`, its `section`, its `parentId` and its `position`.
- `read()` throws `ArcSidebarUnavailableError` when the file is missing or the process cannot read it, and `ArcSidebarFormatError` when the file is not the JSON that Arc writes. The message of the format error names the part that is wrong.
- `version()` gives the change signal, an `AppFilesVersion` of `@workspace/sdk-macos-app-database`. Its value is the file stamp, so it changes when Arc writes the file. A file that the process may not read is the value `unavailable`, not an error.
- `lastWrite()` gives the time of the last write. It throws `ArcSidebarUnavailableError` when the file is missing.

Arc writes a Swift dictionary as its keys and values in turn, an enum case as `{ case: { _0: value } }`, and a date as seconds since 2001-01-01. The SDK decodes all three. It reads dates through `@workspace/codec-apple-reference-date`.
