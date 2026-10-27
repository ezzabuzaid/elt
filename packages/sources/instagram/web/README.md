# @workspace/source-instagram-web

An ELT source for Instagram profiles. Instagram has no Mac app, and no browser keeps its posts on disk. Thus the source reads instagram.com through the web client's own API. It signs in with the session of the browser profile that signed in to Instagram last: Dia, Google Chrome, Arc, Microsoft Edge or Brave.

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

The options also accept a date range, `startAt` and `endAt`.

| Stream            | One record per                                                    |
| ----------------- | ----------------------------------------------------------------- |
| `following`       | account that the signed-in account follows                        |
| `profiles`        | profile as its page shows it now, with its counts                 |
| `posts`           | post on the grid, with its caption, date, counts and tagged place |
| `reels`           | reel on the reels tab, with its plays                             |
| `reposts`         | post of another account that the profile reposted                 |
| `tagged_posts`    | post of another account that tags the profile                     |
| `media`           | image or video of a post, with its file                           |
| `comments`        | comment or reply on a grid post                                   |
| `stories`         | story, with its image                                             |
| `highlights`      | highlight on the profile's page                                   |
| `highlight_items` | story in a highlight, with its image                              |

Every stream other than `following` is partitioned by `profileId`.

## Access

The source decrypts the browser's instagram.com cookies with the key from the browser's "Safe Storage" item in the login keychain. macOS asks one time. When you click Always Allow, later runs do not ask, but every process that runs `/usr/bin/security` can read that key.

- No browser session fails with `BrowserSessionNotFoundError`.
- A keychain item that macOS does not give fails with `SafeStorageUnavailableError`.
- A lost login fails with `InstagramLoginError`.
- A rate limit stops the run with `InstagramRateLimitError`. The next run continues after the last committed page.
- A query that Instagram refuses fails with `InstagramQueryError`, which names the query.

## Limitations

- A run reads at most 10 pages of each list of each profile. A long profile is complete after many runs: 3,479 posts took 11 runs.
- The source sees a deletion only when a scan of the list ends.
- The source does not download videos. `media` keeps the cover frame.
- The source reads comments only for grid posts.
- Reels, reposts and tagged posts have no date, so a date range does not narrow them.
- Instagram does not tell when a profile posts. A watch reads again every hour.

See [docs/reference.md](../../../../docs/reference.md#instagram).
