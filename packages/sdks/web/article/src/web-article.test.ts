import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import { HttpServer } from '@zukhruf/testing/http';
import got, { HTTPError, TimeoutError } from 'got';

import {
  ArchiveReader,
  ListingReader,
  PaginationReader,
  WebCrawler,
} from '@workspace/sdk-web-crawler';

import { ArticleError, HTMLExtraction, WebArticle } from './index.ts';

// These pages are served locally because live publishers cannot provide stable
// content, controlled failure responses, or a deterministic cancellation point.
const paragraphs = [
  'The garden study began in spring. Researchers measured the growth of plants, recorded each change, and compared the results across three beds. Their records explain how daily observations can reveal patterns that are easy to miss during a single visit.',
  'A second team repeated the measurements in autumn. The comparison showed a consistent effect, but the authors also described the limits of the experiment. Readers can inspect the original measurements and repeat the study in their own gardens.',
] as const;
const body = `<article><h1>Field observations</h1>${paragraphs.map((text) => `<p>${text}</p>`).join('')}</article>`;

test('chosen websites and feeds compose with extraction without merging URL variants or losing successful pages', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    switch (request.url) {
      case '/':
        response.end(
          '<link rel="alternate" type="application/rss+xml" href="/feed.xml">',
        );
        break;
      case '/feed.xml':
        response.setHeader('content-type', 'application/rss+xml');
        response.end(`<rss><channel>
          <item><link>/story?edition=1</link></item>
          <item><link>/story?edition=1#again</link></item>
          <item><link>/story?edition=2</link></item>
          <item><link>/story</link></item>
          <item><link>/story/</link></item>
          <item><link>/empty</link></item>
          <item><link>/missing</link></item>
        </channel></rss>`);
        break;
      case '/story?edition=1':
      case '/story?edition=2':
      case '/story':
      case '/story/':
        response.end(
          `<html><head><title>${request.url}</title><link rel="canonical" href="/shared-canonical"></head><body>${body}</body></html>`,
        );
        break;
      case '/empty':
        response.end(
          '<html><body><nav><a href="/">Home</a></nav></body></html>',
        );
        break;
      default:
        response.writeHead(404).end();
    }
  });
  const crawler = new WebCrawler(got, [
    new ListingReader(),
    new ArchiveReader(),
    new PaginationReader(),
  ]);
  const reader = new WebArticle([new HTMLExtraction()], got);
  for (const input of ['/', '/feed.xml']) {
    const signal = AbortSignal.timeout(5000);
    const pages = (
      await Array.fromAsync(
        crawler.crawl([`${upstream.origin}${input}`], null, { signal }),
      )
    )
      // Progress entries only mark documents the crawl read for its readers; a crawl with no memento defers nothing.
      .flatMap((entry) =>
        'progress' in entry || 'deferred' in entry ? [] : [entry],
      );
    assert.deepEqual(
      pages.map((page) => page.url),
      [
        `${upstream.origin}/story?edition=1`,
        `${upstream.origin}/story?edition=2`,
        `${upstream.origin}/story`,
        `${upstream.origin}/story/`,
        `${upstream.origin}/empty`,
        `${upstream.origin}/missing`,
      ],
    );
    assert.ok(
      pages.every((page) => page.listingUrl === `${upstream.origin}/feed.xml`),
    );
    const results = await Promise.allSettled(
      pages.map((page) => reader.fetch(page.url, signal)),
    );
    for (const [index, path] of [
      '/story?edition=1',
      '/story?edition=2',
      '/story',
      '/story/',
    ].entries()) {
      const result = results[index];
      assert.ok(result?.status === 'fulfilled' && result.value);
      assert.equal(result.value.url, `${upstream.origin}${path}`);
      assert.equal(
        result.value.canonicalUrl,
        `${upstream.origin}/shared-canonical`,
      );
      assert.ok(result.value.textContent.includes(paragraphs[0]));
    }
    assert.deepEqual(results[4], { status: 'fulfilled', value: null });
    const missing = results[5];
    assert.ok(missing?.status === 'rejected');
    assert.ok(missing.reason instanceof ArticleError);
    assert.equal(missing.reason.url, `${upstream.origin}/missing`);
  }
});

test('fetches an article with metadata and excludes surrounding navigation', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<html lang="en"><head>
      <title>Field observations</title>
      <meta name="author" content="Lina Haddad">
      <meta property="article:published_time" content="2026-10-20">
      <meta name="description" content="An experiment across two seasons.">
      <meta property="og:site_name" content="Garden Journal">
      </head><body><nav><a href="/subscribe">Subscribe to our newsletter</a></nav>
      ${body}<footer>Privacy policy</footer></body></html>`);
  });

  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    `${upstream.origin}/story`,
    AbortSignal.timeout(5000),
  );

  assert.ok(article);
  assert.equal(article.url, `${upstream.origin}/story`);
  assert.equal(article.title, 'Field observations');
  assert.equal(article.byline, 'Lina Haddad');
  assert.equal(article.publishedTime, '2026-10-20');
  assert.equal(article.excerpt, 'An experiment across two seasons.');
  assert.equal(article.siteName, 'Garden Journal');
  assert.equal(article.lang, 'en');
  assert.ok(article.textContent);
  for (const paragraph of paragraphs)
    assert.ok(article.textContent.includes(paragraph));
  assert.doesNotMatch(article.textContent, /Subscribe|Privacy policy/);
  assert.ok(article.content);
  assert.match(article.content, /<p>/);
});

test('redirects retain the fetched URL and resolve canonical and content links against the HTML base', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/old') {
      response.writeHead(302, { location: '/archive/story?edition=2' }).end();
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<html><head><title>Field observations</title>
      <base href="/journal/"><link rel="canonical" href="story?edition=2#intro">
      </head><body>${body.replace('</p>', ' Read the <a href="measurements">original measurements</a>.</p>')}</body></html>`);
  });

  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    `${upstream.origin}/old`,
    AbortSignal.timeout(5000),
  );

  assert.ok(article);
  assert.equal(article.url, `${upstream.origin}/archive/story?edition=2`);
  assert.equal(
    article.canonicalUrl,
    `${upstream.origin}/journal/story?edition=2`,
  );
  assert.ok(
    article.content.includes(`href="${upstream.origin}/journal/measurements"`),
  );
});

test('plain text retains the article heading and paragraph boundaries in minified HTML', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      `<html><head><title>Field observations</title></head><body>${body}</body></html>`,
    );
  });
  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.ok(article);
  assert.equal(
    article.textContent,
    `FIELD OBSERVATIONS\n\n${paragraphs[0]}\n\n${paragraphs[1]}`,
  );
  assert.equal(article.length, article.textContent.length);
});

test('extracted HTML removes executable markup without dropping article prose', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      `<html><head><title>Field observations</title></head><body>${body.replace('<p>', '<p onclick="alert(1)">').replace('</p>', '<img src="/chart.png" onerror="alert(2)"><script>document.body.textContent = "Replaced by script"</script></p>')}</body></html>`,
    );
  });
  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.ok(article?.content);
  assert.doesNotMatch(
    article.content,
    /onclick|onerror|<script|Replaced by script/,
  );
  assert.match(article.content, /chart\.png/);
  assert.ok(article.textContent.includes(paragraphs[0]));
});

test('reading an article never executes its scripts or fetches embedded resources', async () => {
  const resourceRequests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url !== '/story') {
      assert.ok(request.url);
      resourceRequests.push(request.url);
      response.end();
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<html><head><title>Field observations</title>
      <link rel="stylesheet" href="/stylesheet.css">
      <style>@import url('/import.css');</style>
      <script src="/external.js"></script>
      </head><body>${body}
      <iframe src="/embedded"></iframe><img src="/photo.png">
      <script>
        document.querySelector('article').textContent = 'Script replaced the article';
        const request = new XMLHttpRequest();
        request.open('GET', '/beacon');
        request.send();
      </script></body></html>`);
  });
  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    `${upstream.origin}/story`,
    AbortSignal.timeout(5000),
  );
  assert.ok(article);
  assert.ok(article.textContent.includes(paragraphs[0]));
  assert.doesNotMatch(
    article.content,
    /<script|<iframe|Script replaced the article/,
  );
  assert.deepEqual(resourceRequests, []);
});

test('injected request deadlines close an unfinished response and preserve the timeout cause', async () => {
  const closed = Promise.withResolvers<void>();
  let streaming = false;
  await using upstream = await new HttpServer().start((_request, response) => {
    streaming = true;
    response.once('close', () => closed.resolve());
    response.writeHead(200, { 'content-type': 'text/html' });
    response.write('<article><p>An unfinished response');
  });
  const reader = new WebArticle(
    [new HTMLExtraction()],
    got.extend({ timeout: { request: 250 }, retry: { limit: 0 } }),
  );
  await assert.rejects(
    reader.fetch(upstream.origin, AbortSignal.timeout(5000)),
    (error: unknown) =>
      error instanceof ArticleError && error.cause instanceof TimeoutError,
  );
  assert(streaming, 'the deadline must interrupt body consumption');
  await closed.promise;
});

test('permanent HTTP and extraction failures do not repeat their downloads', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '/');
    if (request.url === '/json')
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    else response.writeHead(request.url === '/missing' ? 404 : 304).end();
  });
  for (const path of ['/missing', '/not-modified', '/json']) {
    await assert.rejects(
      new WebArticle([new HTMLExtraction()], got).fetch(
        `${upstream.origin}${path}`,
        AbortSignal.timeout(5000),
      ),
      (error: unknown) => {
        assert(error instanceof ArticleError);
        if (path !== '/json') assert(error.cause instanceof HTTPError);
        return true;
      },
    );
  }
  assert.deepEqual(requests, ['/missing', '/not-modified', '/json']);
});

test('HTTP, transport and unsupported content failures identify the failed URL', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/unavailable' }).end();
    } else if (request.url === '/disconnect') {
      request.socket.destroy();
    } else {
      response.writeHead(request.url === '/unavailable' ? 503 : 200, {
        'content-type':
          request.url === '/json' ? 'application/json' : 'text/html',
      });
      response.end(`<html><body>${body}</body></html>`);
    }
  });
  for (const path of ['/redirect', '/json', '/disconnect']) {
    await assert.rejects(
      new WebArticle([new HTMLExtraction()], got).fetch(
        `${upstream.origin}${path}`,
        AbortSignal.timeout(5000),
      ),
      (error: unknown) => {
        assert.ok(error instanceof ArticleError);
        assert.equal(
          error.url,
          `${upstream.origin}${path === '/redirect' ? '/unavailable' : path}`,
        );
        assert.ok(error.cause);
        return true;
      },
    );
  }
});

test('truncated and corrupt response bodies fail instead of returning partial article text', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    const html = `<html><head><title>Field observations</title></head><body>${body}</body></html>`;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/truncated') {
      response.setHeader('content-length', Buffer.byteLength(html) + 100);
      response.setHeader('connection', 'close');
    } else {
      response.setHeader('content-encoding', 'gzip');
    }
    response.end(html);
  });
  for (const path of ['/truncated', '/corrupt-gzip']) {
    await assert.rejects(
      new WebArticle([new HTMLExtraction()], got).fetch(
        `${upstream.origin}${path}`,
        AbortSignal.timeout(5000),
      ),
      (error: unknown) => {
        assert.ok(error instanceof ArticleError);
        assert.equal(error.url, `${upstream.origin}${path}`);
        assert.ok(Error.isError(error.cause));
        return true;
      },
    );
  }
});

test('cancellation before and during a download preserves the caller reason', async () => {
  for (const phase of ['before', 'headers', 'body']) {
    const controller = new AbortController();
    const reason = new Error(`Stopped during ${phase}`);
    await using upstream = await new HttpServer().start(
      (_request, response) => {
        if (phase === 'body') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.write('<html><body>');
        }
        controller.abort(reason);
      },
    );
    if (phase === 'before') controller.abort(reason);
    await assert.rejects(
      new WebArticle([new HTMLExtraction()], got).fetch(
        upstream.origin,
        AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      ),
      (error: unknown) => error === reason,
    );
  }
});

test('cancelling a streaming page leaves concurrent and later calls usable on the same reader', async () => {
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  const reason = new Error('Stop only the unfinished article');
  await using upstream = await new HttpServer().start((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (request.url === '/streaming') {
      response.write(`<html><body>${body}`, () => started.resolve());
    } else {
      response.end(
        `<html><head><title>Field observations</title></head><body>${body}</body></html>`,
      );
    }
  });
  const reader = new WebArticle([new HTMLExtraction()], got);
  const stopped = assert.rejects(
    reader.fetch(
      `${upstream.origin}/streaming`,
      AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    ),
    (error: unknown) => error === reason,
  );
  try {
    await Promise.race([started.promise, stopped]);
    // A complete second request gives the first time to enter body consumption.
    const concurrent = await reader.fetch(
      `${upstream.origin}/complete`,
      AbortSignal.timeout(5000),
    );
    assert.equal(concurrent?.title, 'Field observations');
  } finally {
    controller.abort(reason);
    await stopped;
  }
  const subsequent = await reader.fetch(
    `${upstream.origin}/complete`,
    AbortSignal.timeout(5000),
  );
  assert.ok(subsequent?.textContent.includes(paragraphs[0]));
});

test('empty and navigation-only pages return no article', async () => {
  for (const html of [
    '',
    '<html><body><nav><a href="/">Home</a><a href="/login">Log in</a></nav></body></html>',
    '<html><body><div role="navigation"><a href="/">Home</a><a href="/login">Log in</a></div></body></html>',
    '<html><body><nav><p>Browse the garden journal by season.</p><a href="/spring">Spring</a><a href="/autumn">Autumn</a></nav></body></html>',
  ]) {
    await using upstream = await new HttpServer().start(
      (_request, response) => {
        response.setHeader('content-type', 'text/html');
        response.end(html);
      },
    );
    assert.equal(
      await new WebArticle([new HTMLExtraction()], got).fetch(
        upstream.origin,
        AbortSignal.timeout(5000),
      ),
      null,
    );
  }
});

test('standard structured metadata takes precedence and absent publication dates stay unknown', async () => {
  for (const structured of [true, false]) {
    await using upstream = await new HttpServer().start(
      (_request, response) => {
        response.setHeader('content-type', 'text/html');
        response.end(`<html><head><title>Field observations</title>
        <script type="application/ld+json">invalid JSON</script>
        ${
          structured
            ? `<script type="application/ld+json">{
          "@context":"https://schema.org", "@graph":[
            {"@type":"WebSite", "name":"Journal"},
            {"@type":"NewsArticle", "headline":"Garden results",
             "author":[{"@type":"Person", "name":"Lina Haddad"},{"@type":"Person", "name":"Omar Ali"}],
             "datePublished":"2026-10-20T09:30:00+03:00",
             "description":"A two-season study", "publisher":{"name":"Garden Journal"}}
          ]}</script>`
            : ''
        }
        </head><body>${body.replace('began in spring', 'began on 1998-04-12')}</body></html>`);
      },
    );
    const article = await new WebArticle([new HTMLExtraction()], got).fetch(
      upstream.origin,
      AbortSignal.timeout(5000),
    );
    assert.ok(article);
    assert.equal(
      article.title,
      structured ? 'Garden results' : 'Field observations',
    );
    assert.equal(article.byline, structured ? 'Lina Haddad, Omar Ali' : null);
    assert.equal(
      article.publishedTime,
      structured ? '2026-10-20T09:30:00+03:00' : null,
    );
    assert.equal(article.canonicalUrl, null);
  }
});

test('decodes HTTP and HTML charset declarations and preserves Unicode', async () => {
  for (const declaration of ['http', 'html', 'utf8']) {
    await using upstream = await new HttpServer().start(
      (_request, response) => {
        if (declaration !== 'html')
          response.setHeader(
            'content-type',
            declaration === 'utf8'
              ? 'text/html; charset=utf-8'
              : 'text/html; charset=iso-8859-1',
          );
        response.end(
          Buffer.from(
            `<html><head><title>Café &amp; rivière</title>${declaration === 'html' ? '<meta charset="iso-8859-1">' : ''}</head><body>${body.replace('garden study', declaration === 'utf8' ? 'حديقة café study' : 'café study')}</body></html>`,
            declaration === 'utf8' ? 'utf8' : 'latin1',
          ),
        );
      },
    );
    const article = await new WebArticle([new HTMLExtraction()], got).fetch(
      upstream.origin,
      AbortSignal.timeout(5000),
    );
    assert.ok(article);
    assert.equal(article.title, 'Café & rivière');
    assert.ok(
      article.textContent.includes(
        declaration === 'utf8' ? 'حديقة café study' : 'café study',
      ),
    );
    assert.doesNotMatch(article.textContent, /�|Ã/);
  }
});

test('invalid and non-web canonical declarations cannot become article identities', async () => {
  for (const href of [
    'http://[invalid',
    'javascript:alert(1)',
    'mailto:author@example.org',
  ]) {
    await using upstream = await new HttpServer().start(
      (_request, response) => {
        response.setHeader('content-type', 'text/html');
        response.end(
          `<html><head><title>Field observations</title><link rel="canonical" href="${href}"></head><body>${body}</body></html>`,
        );
      },
    );
    const article = await new WebArticle([new HTMLExtraction()], got).fetch(
      upstream.origin,
      AbortSignal.timeout(5000),
    );
    assert.ok(article);
    assert.equal(article.canonicalUrl, null);
  }
});

test('short posts retain their prose instead of being rejected by a length threshold', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      '<html><head><title>A brief field note</title></head><body><nav><a href="/">Home</a></nav><article><p>The first seeds emerged today.</p><p>We will measure their growth tomorrow.</p></article></body></html>',
    );
  });
  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.ok(article);
  assert.equal(
    article.textContent,
    'The first seeds emerged today.\n\nWe will measure their growth tomorrow.',
  );
});

test('prose in plain div elements remains readable without an article or paragraph tag', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(
      `<html><head><title>Field observations</title></head><body><main><div>${paragraphs[0]}</div><div>${paragraphs[1]}</div></main></body></html>`,
    );
  });
  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.ok(article);
  assert.ok(article.textContent.includes(paragraphs[0]));
  assert.ok(article.textContent.includes(paragraphs[1]));
});

test('a standalone data table remains readable without surrounding paragraph tags', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(
      '<html><head><title>Rainfall observations</title></head><body><main><table><tr><th>Season</th><th>Rainfall</th></tr><tr><td>Spring</td><td>37 mm</td></tr><tr><td>Autumn</td><td>52 mm</td></tr></table></main></body></html>',
    );
  });
  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.ok(article);
  assert.match(article.textContent, /Spring\s+37 mm/);
  assert.match(article.textContent, /Autumn\s+52 mm/);
});

test('compressed pages respect the HTTP charset over conflicting HTML metadata', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    const html = Buffer.from(
      `<html><head><meta charset="utf-8"><title>Café observations</title></head><body>${body.replace('garden study', 'café study')}</body></html>`,
      'latin1',
    );
    response.writeHead(200, {
      'content-type': 'text/html; charset=iso-8859-1',
      'content-encoding': request.url === '/gzip' ? 'gzip' : 'br',
    });
    response.end(
      request.url === '/gzip' ? gzipSync(html) : brotliCompressSync(html),
    );
  });
  for (const path of ['/gzip', '/brotli']) {
    const article = await new WebArticle([new HTMLExtraction()], got).fetch(
      `${upstream.origin}${path}`,
      AbortSignal.timeout(5000),
    );
    assert.ok(article);
    assert.equal(article.title, 'Café observations');
    assert.match(article.textContent, /café study/);
    assert.doesNotMatch(article.textContent, /�|Ã/);
  }
});

test('plain text keeps data-table columns distinguishable', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      `<html><head><title>Field observations</title></head><body>${body.replace('</article>', '<table><tr><th>Season</th><th>Rainfall</th></tr><tr><td>Spring</td><td>37 mm</td></tr><tr><td>Autumn</td><td>52 mm</td></tr></table></article>')}</body></html>`,
    );
  });
  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.ok(article);
  assert.match(article.textContent, /SEASON\s+RAINFALL/i);
  assert.match(article.textContent, /Spring\s+37 mm/);
  assert.match(article.textContent, /Autumn\s+52 mm/);
});
