# Recipe: Write your own revisit policy

**Use case.** No revisit policy of this package has the rule that you need. For example: a blog post never changes after the blog publishes it. When a crawl downloaded a post once, no later crawl must request it again. The feed must still be read in each crawl, so that new posts are found.

**What you need.** A subclass of `IntervalRevisit` or `RevisitPolicy`. A policy decides only when a URL is due again. The crawler downloads, compares bodies and keeps the schedule.

## The rules

1. **Give a `histories` schema.** The history of a URL is plain data in the crawl memento. The crawler parses it with this zod schema before it gives it to your policy. A policy with no history uses `z.null()`.
2. **Return `{ due, history }` for each visit.** `due` is a time in milliseconds, or `null` for "never". `history` is what your policy must know at the next visit.
3. **Extend `IntervalRevisit` to keep its failure rule.** A failed URL is due two hours later, and a gone URL (404 or 410) one day later. You implement only `visited`, which runs after a download that succeeded. Its `outcome` is `modified`, `unmodified` or `unknown`.
4. **Extend `RevisitPolicy` to decide failed and gone URLs too.** You then implement `schedule`, which gets every `outcome`.
5. **Override `due` to read a hint before the download.** The default makes a URL due when its time came, or when a listing gives it another `lastModified` than at the last visit.

## The program

`NeverRevisit` gives each post that loaded `due: null`. The feed is the starting URL, and a starting URL is always due. On the second crawl, the feed names a new post.

```ts title="never-revisit.ts"
import { once } from 'node:events';
import { createServer } from 'node:http';

import got from 'got';
import { z } from 'zod';

import {
  IntervalRevisit,
  ListingReader,
  type Schedule,
  WebCrawler,
} from '@workspace/sdk-web-crawler';

/** A page that loaded once is never due again. A failed or gone page is tried again. */
class NeverRevisit extends IntervalRevisit<null> {
  readonly histories = z.null();
  protected visited(): Schedule<null> {
    return { due: null, history: null };
  }
}

// A blog whose feed names the posts that it published so far.
let published = [1, 2];
let requested: string[] = [];
const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', origin);
  requested.push(pathname);
  if (pathname === '/feed.json') {
    response.setHeader('content-type', 'application/feed+json');
    response.end(
      JSON.stringify({
        version: 'https://jsonfeed.org/version/1.1',
        title: 'Blog',
        items: published.map((n) => ({
          id: `${n}`,
          url: `${origin}/posts/${n}`,
        })),
      }),
    );
  } else if (pathname.startsWith('/posts/')) {
    response.setHeader('content-type', 'text/html');
    response.end(`<title>${pathname}</title>`);
  } else response.writeHead(404).end();
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('No port');
const origin = `http://127.0.0.1:${address.port}`;

const crawler = new WebCrawler(
  got.extend({ timeout: { request: 30_000 } }),
  [new ListingReader()],
  new NeverRevisit(),
);
let memento: unknown = null;
for (const name of ['first crawl', 'second crawl']) {
  requested = [];
  const crawl = crawler.crawl([`${origin}/feed.json`], memento, {
    signal: AbortSignal.timeout(60_000),
  });
  for await (const entry of crawl) if ('error' in entry) throw entry.error;
  memento = crawl.snapshot();
  const due = Object.entries(crawl.snapshot().urls)
    .filter(([url]) => url.includes('/posts/'))
    .map(([url, known]) => `${new URL(url).pathname}: ${known.due ?? 'never'}`);
  console.log(name, { requested, due });
  published = [1, 2, 3]; // The blog publishes post 3.
}
server.close();
```

Output:

```
first crawl {
  requested: [ '/robots.txt', '/feed.json', '/posts/1', '/posts/2' ],
  due: [ '/posts/1: never', '/posts/2: never' ]
}
second crawl {
  requested: [ '/robots.txt', '/feed.json', '/posts/3' ],
  due: [ '/posts/1: never', '/posts/2: never', '/posts/3: never' ]
}
```

## Why it works

After the first crawl, each post has `due: null` in the crawl memento. On the second crawl, the feed names posts 1, 2 and 3. The crawler knows posts 1 and 2, and asks the policy whether they are due. They are not, so they stay out of the frontier. Post 3 is new, so the crawl downloads it. The feed is the starting URL, so it is requested in each crawl.

A post that the crawl did not request is a deferred page. `WebSource` of `@workspace/source-web-pages` keeps its rows.

## Is "never" a good practice?

Use it only for pages that do not change after their website publishes them, such as blog posts or closed forum threads. The usual practice is to request a known page again:

- Apache Nutch has no "never". It requests every page again after at most 90 days, "no matter what is its status" (`db.fetch.interval.max`).
- StormCrawler has "never" as an option, not as the default: "set it to -1 to never refetch a page" (`fetchInterval.default`).
- Scrapy has the plugin `scrapy-deltafetch` for a "delta crawl containing only new requests". It skips only the pages that gave items, and it still reads the lists.

Do the same as DeltaFetch: keep the lists on a policy that requests them again. A list that is not a starting URL, such as page 2 of an archive, needs a route of its own:

```ts
new CompositeRevisit(
  [
    [
      new URLPattern({ pathname: '/archive/*' }),
      new FixedRevisit({ every: day }),
    ],
  ],
  new NeverRevisit(),
);
```

Do not use it for pages that change, such as the category pages of a marketplace. With "never", only the starting URL would find new items.

## Things to know

- **A sitemap can still bring a page back.** If a sitemap gives the page another `lastmod`, the default `due` makes it due at once. To ignore that hint, override `due` so that it reads only the time:

  ```ts
  override due(_request: CrawlRequest, known: Known<null>, at: number) {
    return known.due !== null && known.due <= at;
  }
  ```

- **A full refresh ignores your policy.** `WebSource` uses `AlwaysRevisit` for a full refresh, because a full refresh must see every page.
- **The crawl memento keeps every URL.** To remember that it loaded a page, the crawler keeps the URL forever. The crawl memento grows with the website.
- **Keep the history small.** It goes into the crawl memento, and the crawl memento goes into each save.
- **You can change the `histories` schema at any time.** A crawl memento with the old history then does not parse. Delete it and crawl again.
