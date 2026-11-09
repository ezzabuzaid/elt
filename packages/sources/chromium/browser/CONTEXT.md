# Chromium browser

A user wants the history, the downloads, the searches and the bookmarks of a Chromium browser in SQL, such as those of Dia, Chrome, Arc or Edge. Each of these browsers keeps them in the same files, in each profile folder on this Mac. The Chromium browser source reads those files for one browser. The words that all of elt uses, for example stream, copy and watch, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Browser**:
One Chromium browser on this Mac, as a `ChromiumBrowser` of `@eltjs/sdk-chromium-browser` describes it: its data folder in `~/Library/Application Support`, and whether it removes old history. The source reads one browser.
_Avoid_: App, Chromium (Chromium is the code that the browsers share)

**Data folder**:
The folder of a browser that holds its profile folders and its Local State, for example `~/Library/Application Support/Dia/User Data`.
_Avoid_: User data, root, container

**Profile**:
A profile folder in the data folder, such as `Default` or `Profile 1`, that holds a History or a Bookmarks file. Its folder name is its ID (`profileId`). Each stream has `profileId` in its key.
_Avoid_: Account, user, collection

**Local State**:
The JSON file in the data folder where the browser keeps the name of each profile. A profile that Local State does not list has no name.
_Avoid_: Preferences (each profile has a separate Preferences file)

**History**:
The SQLite database of one profile with its URLs, visits, searches and downloads. A running browser holds it in exclusive locking mode, so the source reads a checked copy of it.
_Avoid_: History.db (that is Safari's file)

**Bookmarks**:
The JSON file of one profile with its bookmarks and folders. The browser replaces the whole file on each change.
_Avoid_: Favorites

**Store**:
The files that one group of streams reads: History (`historyItems`, `historyVisits`, `downloads`, `searchTerms`), Bookmarks (`bookmarks`), or Local State with the profile folders (`profiles`). Each store opens, fails and wakes a watch separately.
_Avoid_: Database, file

**Expiry**:
The time when a browser that removes old history removes a row: a visit 90 days after it occurred, a visit of a frame that loaded by itself 3 days earlier, and a URL and its searches with their last visit. Only a browser that removes old history gives its history streams `expiresAt`.
_Avoid_: Retention (that is the deletion policy of elt), TTL
