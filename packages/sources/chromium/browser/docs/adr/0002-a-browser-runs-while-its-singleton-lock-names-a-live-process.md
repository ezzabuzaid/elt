# A browser runs while its SingletonLock names a live process

Status: accepted, 2026-11-02.

## Context

`currentAsOf` tells readers how current a stream is. A browser writes its History and its Bookmarks only while it runs. Sync brings the visits and bookmarks of the user's other devices only while it runs. So while the browser is closed, these stores are current only as of the last write of the browser.

The source must know if the browser runs. A running Chromium browser makes the link `SingletonLock` in its data folder. The link points to `<host>-<process ID>`. The browser does not remove the link when it crashes. Chromium's `ProcessSingleton` trusts the link only when its host is this host and its process is alive. On 2026-11-02, Arc was closed, but its data folder held a `SingletonLock` from January 2026 that named a process that did not exist.

## Decision

`ChromiumBrowser.running(home)` reads `SingletonLock` as Chromium does. The browser runs when the link names this host and a live process. `EPERM` from `process.kill(pid, 0)` means that the process is alive under a different user.

`currentAsOf` returns `null` (current as of the pass) while the browser runs. While the browser is closed, it returns the latest write time of the History files or the Bookmarks files of the selected profiles. `profiles` is always current as of the pass, because only this Mac changes Local State and the profile folders.

## Consequences

- No process list and no app name is necessary. The check works for each Chromium browser with the same code.
- An unrelated process that has the process ID of a crashed browser makes the browser seem to run. Chromium has the same limit.
