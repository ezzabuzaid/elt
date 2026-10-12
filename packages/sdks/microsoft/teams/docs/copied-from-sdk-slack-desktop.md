# Code copied from the Slack SDK

The Slack app and the Teams app both keep their data in Chromium's IndexedDB, and the two SDKs read a live store the same way. This SDK keeps its own copy of that code, and does not share it with `sdk-slack-desktop` yet.

The reason is the Rule of Three. It counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. The boundary of the shared code then comes from three working copies, not from a guess. The next reader of a live Chromium IndexedDB is the third place. When it comes, the shared parts move to their own package (backlog #2596). Until then, a fix in one copy is made in the other copy too, and the commit names both files. This note is the input for that step.

Paths on the left are in `packages/sdks/slack/desktop/src`. Paths on the right are in `packages/sdks/microsoft/teams/src`.

## Copied with changes

**`fields.ts` → `fields.ts`.**

- Its errors are `TeamsFormatError`, not `SlackDesktopFormatError`.
- `requiredNumber`, `values` and `stringValues` are not copied: no Teams record needs them.
- New readers for what Teams writes and Slack does not:
  - `text` and `requiredText`: an id that is a number in some records and text in others, such as an activity's source message.
  - `flag`: a boolean that is also written as `"true"` or `"false"`.
  - `milliseconds` and `requiredMilliseconds`: an instant written as a count of milliseconds or as its digits.
  - `instant(name, precision)` and `requiredInstant`: ISO 8601 text, in UTC or at an offset, kept to its fraction digits without a `Date`.
  - `requiredDate`: a V8 `Date`.
  - `parsedObject` and `parsedList`: an object or a list written as itself or as its JSON text.
- `json` also reads JSON text, and gives `null` for an empty list or object.
- JSON text that has raw control characters in a string is read again with them escaped. Teams writes some link previews so.

Why: Teams keeps one value in more than one form between its records.

**`slack-desktop-store.ts` → `teams-store.ts`.**
Only these parts are copied:

- `#read`: three attempts, a retry on `ENOENT` while the directory exists, `IndexedDBFormatError` changed to the SDK's format error, and the codes in `unreadable` changed to the SDK's access error.
- `#exists`, the `unreadable` set and `errorCode`.
- `version()`, without `storage/root-state.json`: Teams has no file of its own beside its IndexedDB. It keys each file by its name, where Slack's keys it by its full path.

The choice between two installations (`slackDesktopDirectory`) is not copied: Teams has one location.

**`errors.ts` → `errors.ts`.**
The same two classes, `TeamsUnavailableError` and `TeamsFormatError`, with messages that name Microsoft Teams.

## Not a copy

The test writer of a Chromium IndexedDB was in three places (the Slack source test, the CLI test, and these tests). It moved to `IndexedDBWriter` in `@workspace/codec-chromium-indexeddb/test`, and every place uses it.
