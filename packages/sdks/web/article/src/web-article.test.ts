import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';

import { ArticleError, WebArticle } from './index.ts';

// These pages are served locally because live publishers cannot provide stable
// content, controlled failure responses, or a deterministic cancellation point.
const paragraphs = [
  'The garden study began in spring. Researchers measured the growth of plants, recorded each change, and compared the results across three beds. Their records explain how daily observations can reveal patterns that are easy to miss during a single visit.',
  'A second team repeated the measurements in autumn. The comparison showed a consistent effect, but the authors also described the limits of the experiment. Readers can inspect the original measurements and repeat the study in their own gardens.',
] as const;
const body = `<article><h1>Field observations</h1>${paragraphs.map((text) => `<p>${text}</p>`).join('')}</article>`;

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

  const article = await new WebArticle().fetch(
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

  const article = await new WebArticle().fetch(
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

test('plain text preserves paragraph boundaries in minified HTML', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      `<html><head><title>Field observations</title></head><body>${body}</body></html>`,
    );
  });
  const article = await new WebArticle().fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.ok(article);
  assert.equal(article.textContent, `${paragraphs[0]}\n\n${paragraphs[1]}`);
  assert.equal(article.length, article.textContent.length);
});

test('extracted HTML removes executable markup without dropping article prose', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      `<html><head><title>Field observations</title></head><body>${body.replace('<p>', '<p onclick="alert(1)">').replace('</p>', '<img src="/chart.png" onerror="alert(2)"><script>document.body.textContent = "Replaced by script"</script></p>')}</body></html>`,
    );
  });
  const article = await new WebArticle().fetch(
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
      new WebArticle().fetch(
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
      new WebArticle().fetch(
        upstream.origin,
        AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      ),
      (error: unknown) => error === reason,
    );
  }
});

test('empty and navigation-only pages return no article', async () => {
  for (const html of [
    '',
    '<html><body><nav><a href="/">Home</a><a href="/login">Log in</a></nav></body></html>',
  ]) {
    await using upstream = await new HttpServer().start(
      (_request, response) => {
        response.setHeader('content-type', 'text/html');
        response.end(html);
      },
    );
    assert.equal(
      await new WebArticle().fetch(upstream.origin, AbortSignal.timeout(5000)),
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
    const article = await new WebArticle().fetch(
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
    const article = await new WebArticle().fetch(
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
    const article = await new WebArticle().fetch(
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
  const article = await new WebArticle().fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.ok(article);
  assert.equal(
    article.textContent,
    'The first seeds emerged today.\n\nWe will measure their growth tomorrow.',
  );
});

test('plain text keeps data-table columns distinguishable', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      `<html><head><title>Field observations</title></head><body>${body.replace('</article>', '<table><tr><th>Season</th><th>Rainfall</th></tr><tr><td>Spring</td><td>37 mm</td></tr><tr><td>Autumn</td><td>52 mm</td></tr></table></article>')}</body></html>`,
    );
  });
  const article = await new WebArticle().fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.ok(article);
  assert.match(article.textContent, /SEASON\s+RAINFALL/i);
  assert.match(article.textContent, /Spring\s+37 mm/);
  assert.match(article.textContent, /Autumn\s+52 mm/);
});
