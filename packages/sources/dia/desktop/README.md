# Dia source

Dia is a Chromium browser for macOS. It closes a tab that the user did not use for some time and keeps it in its [archive](./CONTEXT.md). `DiaDesktopSource` reads the archive into a pipeline, as one stream: `archivedTabs`. It does not start Dia, and it needs no Full Disk Access. The terms are in the glossary, [CONTEXT.md](./CONTEXT.md).

```ts
import { homedir } from 'node:os';

import { DiaDesktopSource } from '@eltjs/source-dia-desktop/dia-desktop-source';

const source = new DiaDesktopSource({ home: homedir() });
```

Put the source in a `Connection` with a destination and a checkpoint store, and run a `Pipeline`. [Load the tabs that Dia archived](./docs/recipes/load-the-tabs-dia-archived.md) shows a full program.

## The stream

`archivedTabs` has one row for each archived tab. Its primary key is `profileId` and `id`, because two profiles can hold a tab with the same id.

| Field        | Value                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `profileId`  | The folder of the Chromium profile, for example `Default` or `Profile 1`.                              |
| `id`         | The UUID of the tab.                                                                                   |
| `title`      | The title of the tab when Dia archived it.                                                             |
| `kind`       | The case of the variant: `webContent` or `supertab`.                                                   |
| `url`        | The URL of a web page. It is null for a supertab.                                                      |
| `archivedAt` | When Dia archived the tab, in UTC to the microsecond.                                                  |
| `spaceId`    | The UUID of the space that held the tab.                                                               |
| `groupId`    | The UUID of the tab group that held the tab. It is null when the tab was in no group.                  |
| `variant`    | The variant as JSON text with sorted keys. It keeps the fields of a supertab, which Dia does not name. |

The `profileId` is the profile id of the profiles stream of `source-chromium-browser`. The archive can name a profile that Dia removed. The source loads its tabs too.

## Scope

Give an `ImportScope` as `scope`. `collectionIds` selects profiles by their folder names. `startAt` (inclusive) and `endAt` (exclusive) select tabs by `archivedAt`, to the millisecond. A key that you do not give selects all.

```ts
new DiaDesktopSource({
  home: homedir(),
  scope: { collectionIds: ['Default'], startAt: '2026-10-01T00:00:00.000Z' },
});
```

## Sync

Each pass reads the whole archive. The stream is a snapshot stream: an incremental copy writes only the tabs that are new or that changed.

Dia removes an archived tab after an age, when the user restores it, or when the user deletes it, and it records none of these. Thus the stream declares no `emitsDeletes`, and a tab stays in the table after Dia removes it ([ADR 0001](./docs/adr/0001-an-archived-tab-stays-after-dia-removes-it.md)).

Dia writes the keys of a supertab variant in a different order from one write to the next. The source sorts the keys, so such a write changes no row ([ADR 0002](./docs/adr/0002-the-variant-is-json-text-with-sorted-keys.md)).

## Watch

`watch()` reads the [stamp](./CONTEXT.md) of the archive each second. A write of the archive starts a pass of `archivedTabs`. When no tab changed, the pass writes nothing.

## How current a stream is

Dia writes the archive only while it runs. Thus `currentAsOf` is the time of the last write of the archive. See [how current a stream is](../../../elt/README.md#how-current-a-stream-is).

## Errors

- No archive in the home folder: `DiaArchiveMissingError` from `@eltjs/sdk-dia-desktop`. Dia is not installed, or it did not archive a tab yet. The failure type is `config`, and the rows that loaded stay.
- An archive in a format that the SDK does not know: `DiaArchiveFormatError`. The message names the place in the file and what is wrong there, for example `containers[0].archivedTabs[1].archiveDate is not a number`. It never shows a title or a URL. The failure type is `system`, and the rows that loaded stay. A read during a write that is not a rename gives this error too. The next pass reads the file again.

## What the source does not read

- **Open tabs.** Dia 1.55.1 keeps them in `tabs.db`, a database that SQLCipher encrypts. Backlog #3588 is about that store.
- **`StorableProfileContainers.json`.** Dia's binary names this file `StorableProfileContainers_Legacy`. Dia stopped writing it on 2025-12-12, so the open tabs in it are old.
- **History, bookmarks and downloads.** `source-chromium-browser` reads them for each Chromium browser, Dia included.

## Limits

- A pass reads the whole archive into memory ([ADR 0003](./docs/adr/0003-a-pass-reads-the-whole-archive-into-memory.md)). The archive was 1.48 MB on 2026-11-02.
- A tab that the user restored or deleted stays in the table, with no mark.

## Live checks

On 2026-11-02, with Dia 1.55.1 on macOS 27:

- The archive held about 2,460 tabs in six profiles (`Default`, `Profile 1`, `3`, `4`, `5` and `6`). `Profile 3` is not a profile of Dia now. One profile held no tab.
- Each tab had `id`, `title`, `variant`, `archiveDate` and `spaceID`. About 2,450 tabs were web pages with a `url`, and 15 were supertabs with no `url`. About 430 tabs had a `groupID`.
- The `url` of each web page was the same as the URL in its variant.
- The archive dates went from 2026-09-03 to 2026-11-02.
- The live test of this package loaded the archive and compared the count of each profile with the file.
