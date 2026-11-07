# Dia SDK

Dia is a Chromium browser for macOS. This SDK reads the archive of Dia, the file where Dia keeps the tabs that it archived. It knows nothing of elt: `@workspace/source-dia-desktop` reads it into a pipeline. The terms are in the glossary of the source, [CONTEXT.md](../../../sources/dia/desktop/CONTEXT.md).

```ts
import { homedir } from 'node:os';

import { DiaArchive } from '@workspace/sdk-dia-desktop';

const archive = new DiaArchive(homedir());
const tabs = await archive.tabs();
console.log(tabs.length);
```

## API

- `diaArchivePath(home)` gives the path of the archive in the home folder `home`: `Library/Application Support/Dia/StorableAutoArchive.json`.
- `new DiaArchive(home)` reads the archive in that home folder.
- `tabs()` reads the file one time and gives each archived tab of each profile as an `ArchivedTab`. The archive date of Dia, in seconds since 2001-01-01, becomes UTC text to the microsecond. An absent `url` or `groupID` becomes null. The variant becomes JSON text with sorted keys, so a write that only moves keys gives the same text.
- `version()` gives the change signal, an `AppFilesVersion` of `@workspace/sdk-macos-app-database`. Its value is the file stamp, so it changes when Dia writes the file. A missing file has a stamp too. A file that the process may not read is the value `unavailable`, not an error.
- `lastWrite()` gives the time of the last write of the file.

## Errors

- `DiaArchiveMissingError`: no file is at the path, from `tabs()` or `lastWrite()`.
- `DiaArchiveFormatError`: the file is not JSON, its `version` is not 2, or a field has a different type. The message names the place in the file, for example `containers[2].id.profile`. The message never shows a value.
- Each other error of the read reaches the caller.
