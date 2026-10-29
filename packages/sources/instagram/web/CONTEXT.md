# Instagram web

A user wants the posts of other Instagram profiles in SQL, for example the monthly timetable that a gym posts as images. Instagram has no Mac app, and no browser keeps its posts on disk. The Instagram web source reads instagram.com through the web client's own API, with the session of the user's browser. The words that all of elt uses, for example stream, partition and watch, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Profile**:
An Instagram account whose posts the source reads. Each profile is one partition, with the key `profileId`.
_Avoid_: User, account (the account is the one that is signed in), page

**Signed-in account**:
The Instagram account of the browser session that the source uses. `following` lists the accounts that it follows.
_Avoid_: User, owner, profile

**Session**:
The instagram.com cookies of the browser profile that signed in to Instagram last, decrypted with the key of the browser's Safe Storage item.
_Avoid_: Token, login, credentials

**List**:
One of the four tabs of a profile that the source pages through: the grid (`posts`), the reels tab (`reels`), reposts (`reposts`) and tagged posts (`tagged_posts`).
_Avoid_: Feed, tab (in a sentence about the streams), timeline

**Scan**:
One walk through a list, from its top to its end, over one or more runs.
_Avoid_: Crawl, sync, run (a run reads a maximum of 10 pages of a scan)

**Part**:
One page of a scan that commits on its own. The part that gets to the end of the list deletes what no part listed.
_Avoid_: Chunk, batch, slice

**Field error**:
A GraphQL error that Instagram sends next to the data of its answer. It names a field that Instagram set to null.
_Avoid_: Query error (a refused query has errors and no data), partial failure
