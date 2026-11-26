import assert from 'node:assert/strict';

import { Msw } from '@zukhruf/testing/msw';
import { test } from '@zukhruf/testing/node';
import got from 'got';
import { HttpResponse, http } from 'msw';
import { z } from 'zod';

import {
  AdaptiveRevisit,
  type Crawl,
  type CrawlOptions,
  type CrawlSnapshot,
  LinkReader,
  Origins,
  type SavedCrawl,
  applySnapshot,
} from './index.ts';
import { InstantClock } from './instant-clock.ts';

// Got retries no failure, so each visit is one answer.
const noRetries = got.extend({ retry: { limit: 0 } });

// A synthetic site whose pages link the paths given for each, with no
// robots.txt unless one is given; a path not given answers 500.
function site(
  pages: Readonly<Record<string, readonly string[]>>,
  robots?: string,
) {
  return new Msw().intercept(
    http.get('https://site.test/robots.txt', () =>
      robots === undefined
        ? new HttpResponse(null, { status: 404 })
        : HttpResponse.text(robots),
    ),
    http.get('https://site.test/*', ({ request }) => {
      const links = pages[new URL(request.url).pathname];
      return links === undefined
        ? new HttpResponse(null, { status: 500 })
        : HttpResponse.html(
            links.map((path) => `<a href="${path}">${path}</a>`).join(''),
          );
    }),
  );
}

// A crawler of a new read, whose waits take no real time.
function crawler() {
  return new Origins(noRetries, null, new InstantClock(Date)).crawler(
    noRetries,
    [new LinkReader({ maxDepth: 3, maxPages: 100 })],
    new AdaptiveRevisit(),
  );
}

const start = 'https://site.test/';

function pathOf(url: string) {
  return new URL(url).pathname;
}

// An entry of a crawl as its kind and its URL's path.
function described(
  entry: Crawl extends AsyncIterable<infer Entry> ? Entry : never,
) {
  if ('response' in entry) return `page ${pathOf(entry.url)}`;
  if ('error' in entry) return `failure ${pathOf(entry.url)}`;
  if ('progress' in entry) return `progress ${pathOf(entry.progress)}`;
  if ('gone' in entry) return `gone ${pathOf(entry.gone.url)}`;
  return `deferred ${pathOf(entry.deferred.url)}`;
}

// The paths that a snapshot puts and removes.
function changed({ urls }: CrawlSnapshot) {
  return {
    put: [...urls.put.keys()].map(pathOf).toSorted(),
    remove: [...urls.remove].map(pathOf).toSorted(),
  };
}

// A snapshot as a store keeps it: the memento and each record through JSON.
function stored({ memento, urls }: CrawlSnapshot): CrawlSnapshot {
  const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  return {
    memento: json(memento),
    urls: {
      put: new Map(
        urls.put.entries().map(([url, record]) => [url, json(record)]),
      ),
      remove: urls.remove,
    },
  };
}

// One crawl, with a snapshot at each entry as a host saves, until the entry
// that stop counts, or to its end: its entries and what the host keeps.
async function crawled(crawl: Crawl, kept: SavedCrawl | null, stop = Infinity) {
  const entries: string[] = [];
  let saved = kept;
  for await (const entry of crawl) {
    entries.push(described(entry));
    saved = applySnapshot(saved, stored(crawl.snapshot()));
    if (entries.length === stop) break;
  }
  return { entries, kept: applySnapshot(saved, stored(crawl.snapshot())) };
}

// A home page that links four pages, one of which fails and one of which
// links a page more and the home page, which the crawl then downloads again
// as a page; so a crawl hands out progress, pages and a failure.
const pages = {
  '/': ['/a', '/b', '/c', '/bad'],
  '/a': ['/d', '/'],
  '/b': [],
  '/c': ['/a'],
  '/d': [],
};

void test.each([1, 2, 3, 4, 5, 6, 7], (stop) =>
  test(`a crawl stopped after entry ${stop} and resumed from what its host kept hands out the rest, and ends with the pages, the due time and the failures of a crawl that was not stopped`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    await using server = site(pages);
    const options: CrawlOptions = { signal: t.signal };
    const whole = crawler().crawl([start], null, options);
    const uninterrupted = await crawled(whole, null);

    const first = await crawled(
      crawler().crawl([start], null, options),
      null,
      stop,
    );
    const resumed = crawler().crawl([start], first.kept, options);
    const rest = await crawled(resumed, first.kept);

    const before = first.entries.slice(0, -1);
    const handed = rest.entries.filter(
      (entry) => !entry.startsWith('deferred'),
    );
    assert.equal(uninterrupted.entries.length, 7);
    // The entry handed out last was unfinished, so the resumed crawl hands it out again.
    assert.deepEqual([...before, ...handed], uninterrupted.entries);
    // A page handed out before the stop is not due, so the resumed crawl defers it.
    assert.deepEqual(
      rest.entries.filter((entry) => entry.startsWith('deferred')),
      before
        .filter((entry) => entry.startsWith('page'))
        .filter((entry) => !handed.includes(entry))
        .map((entry) => entry.replace('page', 'deferred')),
    );
    assert.equal(resumed.nextDue(), whole.nextDue());
    assert.deepEqual(resumed.failures(), whole.failures());
  }),
);

test('a snapshot puts only the URLs whose records changed since the last one: the page handed out before, now visited, and what this page found, not the pages before it or a known page found again', async (t) => {
  await using server = site({
    '/': ['/p1'],
    '/p1': ['/p2'],
    '/p2': ['/p3', '/p1'],
    '/p3': ['/p1', '/p2'],
  });
  const crawl = crawler().crawl([start], null, { signal: t.signal });
  const snapshots: { put: string[]; remove: string[] }[] = [];

  for await (const _ of crawl) snapshots.push(changed(crawl.snapshot()));
  snapshots.push(changed(crawl.snapshot()));

  assert.deepEqual(snapshots, [
    { put: ['/', '/p1'], remove: [] },
    { put: ['/', '/p2'], remove: [] },
    { put: ['/p1', '/p3'], remove: [] },
    { put: ['/p2'], remove: [] },
    { put: ['/p3'], remove: [] },
  ]);
});

test('a second snapshot with no step of the crawl between them puts and removes nothing', async (t) => {
  await using server = site(pages);
  const crawl = crawler().crawl([start], null, { signal: t.signal });
  const snapshots: CrawlSnapshot[] = [];

  for await (const _ of crawl) {
    crawl.snapshot();
    snapshots.push(crawl.snapshot());
  }

  assert.deepEqual(
    snapshots.map(changed),
    snapshots.map(() => ({ put: [], remove: [] })),
  );
});

test('a crawl is complete only once it requested every URL it had, and asking keeps the changes for the next snapshot', async (t) => {
  await using server = site(pages);
  const crawl = crawler().crawl([start], null, { signal: t.signal });
  const running: boolean[] = [];

  for await (const _ of crawl) {
    crawl.snapshot();
    running.push(crawl.complete);
  }
  const complete = crawl.complete;

  assert.deepEqual(
    running,
    running.map(() => false),
  );
  assert.equal(complete, true);
  // The visit of the last entry, the home page downloaded again as a page
  // that /a links, and its leaving the frontier.
  assert.deepEqual(changed(crawl.snapshot()), { put: ['/'], remove: [] });
});

test('a crawl whose origin blocks it, leaving URLs held back, is not complete', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  await using server = new Msw().intercept(
    http.get(
      'https://site.test/robots.txt',
      () => new HttpResponse(null, { status: 404 }),
    ),
    http.get('https://site.test/b', () => {
      return new HttpResponse(null, {
        status: 429,
        headers: { 'retry-after': '120' },
      });
    }),
    http.get('https://site.test/*', () =>
      HttpResponse.html('<a href="/a">A</a><a href="/b">B</a>'),
    ),
  );
  const crawl = crawler().crawl([start], null, { signal: t.signal });

  await crawled(crawl, null);

  assert.equal(crawl.complete, false);
});

test('an abandoned crawl is not complete', async (t) => {
  await using server = site(pages);
  const crawl = crawler().crawl([start], null, { signal: t.signal });
  for await (const _ of crawl) break;

  crawl.abandon();

  assert.equal(crawl.complete, false);
});

test('a URL found but never visited that robots.txt disallows leaves what the host keeps', async (t) => {
  await using server = site(
    { '/': ['/private', '/a'], '/a': [] },
    'User-agent: *\nDisallow: /private\n',
  );
  const crawl = crawler().crawl([start], null, { signal: t.signal });
  const snapshots: { put: string[]; remove: string[] }[] = [];

  for await (const _ of crawl) snapshots.push(changed(crawl.snapshot()));
  snapshots.push(changed(crawl.snapshot()));

  assert.deepEqual(snapshots[0]?.put, ['/', '/a', '/private']);
  assert.deepEqual(
    snapshots.flatMap(({ remove }) => remove),
    ['/private'],
  );
});

test('a URL found but never visited that no reader admits, as past a budget, leaves what the host keeps', async (t) => {
  await using server = site({ '/': ['/x', '/y'], '/x': [], '/y': [] });
  const crawl = new Origins(noRetries, null, new InstantClock(Date))
    .crawler(
      noRetries,
      [new LinkReader({ maxDepth: 3, maxPages: 1 })],
      new AdaptiveRevisit(),
    )
    .crawl([start], null, {
      signal: t.signal,
      include: [new URLPattern({ pathname: '/keep/*' })],
    });
  const snapshots: { put: string[]; remove: string[] }[] = [];

  for await (const _ of crawl) snapshots.push(changed(crawl.snapshot()));
  snapshots.push(changed(crawl.snapshot()));

  assert.deepEqual(snapshots[0]?.put, ['/', '/x', '/y']);
  assert.deepEqual(
    snapshots.flatMap(({ remove }) => remove),
    ['/y'],
  );
});

void test.each(['its own turn', 'a later turn'], (turn) =>
  test(`a page that the host fails in ${turn} is a failure of the crawl resumed from what the host kept`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    await using server = site({
      '/': ['/a', '/b', '/c'],
      '/a': [],
      '/b': [],
      '/c': [],
    });
    const crawl = crawler().crawl([start], null, { signal: t.signal });
    let kept: SavedCrawl | null = null;
    for await (const entry of crawl) {
      const at = described(entry);
      // In a later turn, the snapshots after its visit already gave /a's record.
      if (at === (turn === 'its own turn' ? 'page /a' : 'page /c'))
        crawl.fail('https://site.test/a');
      kept = applySnapshot(kept, crawl.snapshot());
      if (at === 'page /c') break;
    }

    const resumed = crawler().crawl([start], kept, { signal: t.signal });

    assert.deepEqual(resumed.failures(), ['https://site.test/a']);
  }),
);

test("a crawl resumed from URL records that its host's store gives back in the order of their keys requests an origin's URLs in the order found, also those found after an earlier resume", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  await using server = site({
    '/': ['/c', '/a', '/b'],
    '/c': ['/z'],
    '/a': [],
    '/b': [],
    '/z': [],
  });
  // As a store that reads its records by key gives them back.
  const byKey = ({ memento, urls }: SavedCrawl): SavedCrawl => ({
    memento,
    urls: new Map([...urls].toSorted(([a], [b]) => (a < b ? -1 : 1))),
  });
  const options = { signal: t.signal };
  const first = await crawled(crawler().crawl([start], null, options), null, 1);
  const second = await crawled(
    crawler().crawl([start], byKey(first.kept), options),
    first.kept,
    2,
  );

  const third = await crawled(
    crawler().crawl([start], byKey(second.kept), options),
    second.kept,
  );

  assert.deepEqual(first.entries, ['progress /']);
  assert.deepEqual(second.entries, ['progress /', 'page /c']);
  assert.deepEqual(third.entries, ['page /c', 'page /a', 'page /b', 'page /z']);
});

void test.each(
  [
    {
      case: 'neither known nor pending',
      record: { known: null, pending: null },
    },
    { case: 'not an object', record: 'https://site.test/a' },
  ],
  ({ case: name, record }) =>
    test(`a crawl refuses a saved URL record that is ${name}`, (t) => {
      assert.throws(
        () =>
          crawler().crawl(
            [start],
            {
              memento: { crawl: null, pages: {} },
              urls: new Map([['https://site.test/a', record]]),
            },
            { signal: t.signal },
          ),
        z.ZodError,
      );
    }),
);
