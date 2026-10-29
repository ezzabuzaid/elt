# @workspace/source-instagram-web

An ELT source for Instagram profiles. Instagram has no Mac app: Meta keeps its iPhone and iPad app off Apple silicon Macs (`isIOSBinaryMacOSCompatible: false`), and no browser keeps its posts on disk. Thus the source reads instagram.com through the web client's own API. It signs in with the session of the browser profile that signed in to Instagram last. A Context Compiler import loads every stream into its `data.sqlite`.

The words in this README have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

```ts
import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { InstagramWebSource } from '@workspace/source-instagram-web/instagram-web-source';

// With no profileIds, the source reads every account that the browser's
// Instagram account follows.
const source = await InstagramWebSource.connect({
  profileIds: ['44555906095'],
});
const destination = new SQLiteDestination({ path: './instagram.sqlite' });

await new Pipeline({
  history: new SQLiteSyncHistory(),
  connections: [
    new Connection({
      name: 'instagram',
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: './instagram-state.sqlite',
      }),
      steps: [source.profiles, source.posts, source.comments].map(
        (stream) =>
          new Copy(stream, destination.table(stream.name), {
            id: stream.name,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
      ),
    }),
  ],
}).run();
```

The options also accept a date range, `startAt` and `endAt`. The source reads each profile one time, also when `profileIds` names it more than one time.

## How the source signs in

- `@workspace/sdk-chromium-cookies` finds the browser profile that signed in to Instagram last, among Dia, Google Chrome, Arc, Microsoft Edge and Brave.
- It opens the `Cookies` database of that profile read-only, through the locks of SQLite.
- It decrypts the instagram.com cookies with the key from the browser's "Safe Storage" item in the login keychain, through `/usr/bin/security`. macOS asks one time. When you click Always Allow, later runs do not ask. But then each process that runs `security` can read that key. Always Allow applies to one browser.
- `@workspace/sdk-instagram-web` reads the `fb_dtsg` and `lsd` tokens of the page. Then it sends the persisted GraphQL queries and the REST calls that the web client sends, with its headers.

## Streams

| Stream            | Primary key                         | Each record                                                                                                                                      |
| ----------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `following`       | `id`                                | An account the signed-in account follows: the profiles setup offers. Not partitioned.                                                            |
| `profiles`        | `profileId`                         | A profile as its page shows it now, with its counts and business address.                                                                        |
| `posts`           | `profileId`, `id`                   | A post on the grid, a reel shared to the grid among them, with its caption, date, counts, pinned flag, coauthors, tags and tagged place.         |
| `reels`           | `profileId`, `id`                   | A reel on the reels tab, with its plays. The tab names no date and no caption: join `id` to `posts`.                                             |
| `reposts`         | `profileId`, `id`                   | Another account's post the profile reposted. No date.                                                                                            |
| `tagged_posts`    | `profileId`, `id`                   | Another account's post that tags the profile. No date.                                                                                           |
| `media`           | `profileId`, `list`, `postId`, `id` | One image or video of a post of the four lists, a carousel's slides one each, with its file: a photo's largest rendition, a video's cover frame. |
| `comments`        | `profileId`, `postId`, `id`         | A comment or reply on a grid post, with `parentId` for a reply.                                                                                  |
| `stories`         | `profileId`, `id`                   | A story with its image; `expiresAt` is a day after it was posted.                                                                                |
| `highlights`      | `profileId`, `id`                   | A highlight on the profile's page.                                                                                                               |
| `highlight_items` | `profileId`, `highlightId`, `id`    | A story in a highlight, with its image.                                                                                                          |

Every stream other than `following` is partitioned by `profileId`.

- Instagram's following pages can show one account more than one time, in one page or in pages next to each other. `following` keeps each account one time, with the description of its latest page.
- `profiles.reels` is NULL when Instagram does not send the reel count.
- A post's tagged place is in `locationId`, `locationName`, `latitude` and `longitude`. They are NULL when the post has no place. `latitude` and `longitude` are NULL when Instagram sends a place without coordinates.

Context Compiler reads the text of each stored file into `attachment_text` (see attachment text in [elt](../../../elt/README.md)). Thus you can find a timetable that a profile posted as images:

```sql
SELECT p.url, t.content
FROM media m
JOIN posts p ON p.id = m."postId"
JOIN attachment_text t ON t.ref = m."attachmentRef"
WHERE t.content LIKE '%BodyPump%'
```

The recipe [Search the text of stored files with SQL](../../../destinations/sqlite/docs/recipes/search-the-text-of-stored-files.md) of elt-sqlite shows how a pipeline makes the text of stored files.

## How a run reads Instagram

- **A list is scanned in parts.** A run asks for a maximum of 10 pages of one list of one profile: 33 posts, or 12 reels, reposts or tagged posts, on each page. The streams that read the same list share the pages that a run has. A run first reads the list from the top, down to the newest item that the last run found, after any pinned items. Thus a new post loads at the next run. Then the run continues the scan. Each page is a part (see scans in parts in [elt](../../../elt/README.md)). The part that gets to the end of the list deletes what no part listed. The scan of the media stream reads all four lists, and it ends when each list has ended. See [ADR 0001](./docs/adr/0001-each-list-is-scanned-in-parts-over-runs.md).
- **Snapshots.** The source reads `following`, `profiles`, `stories` and `highlights` fully on each run. A story that Instagram stopped showing keeps its row (`expiresBy`). A story that the profile deleted before then is deleted.
- **Highlight items.** The source reads `highlight_items` fully on each run too, but in parts. Each page that Instagram sends holds the stories of up to five highlights. Each page commits with its images. Thus a download that fails loses only that page, and the next run's diff does not load again the stories that loaded. The first load of a profile downloads every highlight image: about 800 for Hive.
- **Comments.** The source reads comments with the pages of the grid. It reads a post's comments again when the comment count of the post changes, and one time in each scan, so likes stay current. A post with no comments costs no request. Instagram can list one comment more than one time in one answer (15 entries, 8 comments). It loads one time.
- **Files.** The source downloads files only for new and changed records, from Instagram's CDN. The signed URLs of the CDN expire within days, so no record keeps a URL.
  - A file for which the CDN answers 410 Gone loads its record without the file (`attachmentRef` NULL), also when the answer that listed it is new. Three of Hive's highlight videos from July 2025 loaded so.
  - A download whose connection fails, or that the CDN answers with a 5xx, is tried one more time, at once. An example is the 503 of 2026-10-16. See [ADR 0003](./docs/adr/0003-a-failed-download-is-tried-once-more-at-once.md).
- **When.** Instagram does not tell a client that a profile posted. Thus a watch reads again every hour. A long profile is complete after many runs: @propertyplus.jo, with 3,479 posts, takes 11 runs.
- **Date range.** The date range of a selection narrows posts, their media and comments, stories and highlight items. The walk of the grid stops at the first post that is not pinned and is older than the range. Reels, reposts and tagged posts name no date, so the range does not narrow them.
- **Failures.**
  - A redirect to Instagram's login page, or a web page where the SDK asked for JSON, is a lost login: `InstagramLoginError`, with the failure type `config`.
  - A 429, or a 401 that says "Please wait a few minutes", is a rate limit: `InstagramRateLimitError`, with the failure type `system`. The run stops at once. The next run continues after the last committed page.
  - A refused query (errors and no data), or an answer without a field that the SDK reads, fails with `InstagramQueryError`, which names the query.
  - Errors next to data are GraphQL field errors. Instagram sets the field to null and sends the rest, and the SDK reads it. Such an answer fails only when the field is one that the SDK reads. See [ADR 0002](./docs/adr/0002-an-answer-with-field-errors-next-to-its-data-is-read.md).
  - No browser session fails with `BrowserSessionNotFoundError`. A Safe Storage item that the keychain does not give fails with `SafeStorageUnavailableError`. The user must fix both.
  - A page cursor that Instagram gives two times fails the read of that profile. The read does not loop.

## Instagram's web API

Each GraphQL query is persisted: the client sends its name, a `doc_id`, and the Relay provider variables that the server requires.

- Instagram changes the ids. On 2026-10-14 the query of the grid was `28142289515441884`, then `39229011733413759`, and the server answered both.
- An unknown id answers "Exception was thrown during the execution of a query". The SDK reports it as an `InstagramQueryError` that names the query.
- An answer can have field errors next to its data. On 2026-10-15, pages 5 and 6 of Hive's grid named the `location.profile_pic_url` of four posts as `field_exception`, to the web client and to Node, and sent every post.
- The REST feed (`/api/v1/feed/user/<id>/`) and `web_profile_info` no longer serve a web session, and `/web/search/topsearch/` answers 404.
- Comments, replies and the following list are still REST calls of the web client.

## Limitations

- The source does not download videos: `media` keeps the cover frame (backlog #2632).
- The source does not keep the picture of a tagged place. Instagram answered it with `field_exception` errors. 47 of Hive's 551 posts have a place, and none of the first 99 posts of PropertyPlus have one.
- Instagram's own image descriptions were null on each post that the probe read. `description` is kept for when Instagram writes one.
- The source reads comments only for grid posts. It does not read them for reels that are not on the grid, reposts or tagged posts.
- The reposts and tagged tabs name the slides of a carousel only by `<pk>_<owner id>`, and the reposts tab sends no media type for them. Thus their `media.kind` is NULL. `reels.pinned` is NULL for a reel for which Instagram sends no pin list.
- The source sees a deletion only when a scan ends: within 11 runs for 3,479 posts.

## Live checks

Probed on 2026-10-14 and 2026-10-15 with Dia's session on @hivefitnationgym (552 posts, 15 highlights, 9 live stories) and @propertyplus.jo (3,479 posts):

- The queries, variables and answers that the SDK sends and parses.
- A 33-post page for `first: 50`.
- Highlights of 100, 81 and 52 stories. 100 is Instagram's limit.
- Comments, 15 on each page.
- Answers when signed out: a web page, a login redirect, `Incorrect Query`, and `SecFetch Policy violation`.
- The 401 throttle.
- The grid query also answered without a session, until Instagram throttled this network.

Five Context Compiler CLI syncs with Dia's session on 2026-10-15 and 2026-10-16, with both profiles selected:

1. Failed after 4 seconds: GraphQL answers a signed-in session as `text/javascript`.
2. Partial: 462 posts, 2,181 media rows and 497 comments, and Hive's October timetable in `attachment_text`. A null `play_count`, captions without a date, video renditions without a size, and a repeated comment each failed a stream.
3. Partial after 204 seconds: 303 more posts, 582 comments, 124 reels, 3 reposts and 7 stories. A null pin list, carousel slides without a pk, and a 410 on 3 of Hive's 802 highlight stories each failed a stream. One download failed on the network, with no cause in the sync history (backlog #2652).
4. Partial after 460 seconds: Hive's grid past page 5 for the first time (534 posts in that run), and reposts, tagged posts and reels with no errors. A null like-count flag on a grid post failed the grid, and one failed download lost the full first load of Hive's highlight stories.
5. Succeeded after 677 seconds on 2026-10-16, with no stream that failed: Hive's grid complete at 551 posts, its 802 highlight stories with 799 images (the three for which the CDN answers 410 load without one), and its October timetable found by `LIKE '%BodyPump%'` on 8 images.

Each failure of these syncs is fixed and tested with the shape that Instagram sent. The `field_exception` that stopped Hive's grid at page 5 did not come from Node: the answer of the signed-in browser to the same request has the same field errors next to all 33 posts, and the SDK now reads it.

## Decisions

- [ADR 0001: Each list is scanned in parts over runs](./docs/adr/0001-each-list-is-scanned-in-parts-over-runs.md)
- [ADR 0002: An answer with field errors next to its data is read](./docs/adr/0002-an-answer-with-field-errors-next-to-its-data-is-read.md)
- [ADR 0003: A failed download is tried once more at once](./docs/adr/0003-a-failed-download-is-tried-once-more-at-once.md)
