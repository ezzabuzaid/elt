import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';
import { JSDOM } from 'jsdom';

import { HTMLExtraction, MarkdownExtraction, WebArticle } from './index.ts';

test('native Markdown keeps its raw source while HTML supplies article boundaries and missing metadata', async () => {
  const markdown =
    '\n[Skip to content](#main)\n\n[Journal home](/)\n\nRead the [field results](/results).\n\n| Plot | Count |\n| --- | --- |\n| North | 7 |\n\n```js\n  sample();\n```\n\n[Privacy policy](/privacy)\n\n{"@type":"BlogPosting"}\n';
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.headers.accept?.startsWith('text/markdown')) {
      response
        .writeHead(200, { 'content-type': 'text/markdown' })
        .end(
          `---\ntitle: Native field report\ndescription: Publisher summary\n---\n${markdown}`,
        );
    } else {
      response.writeHead(200, { 'content-type': 'text/html' }).end(`
        <html lang="en" dir="ltr"><head><title>HTML field report</title>
          <meta name="author" content="Lina Haddad">
          <meta property="article:published_time" content="2026-10-24T09:00:00Z">
          <meta property="og:site_name" content="Field Journal">
          <link rel="canonical" href="/report">
        </head><body><nav>Skip to content <a href="/">Journal home</a></nav>
          <article id="main"><p>Read the <a href="/results">field results</a>.</p>
            <table><tr><th>Plot</th><th>Count</th></tr><tr><td>North</td><td>7</td></tr></table>
            <pre><code>  sample();</code></pre>
          </article><footer>Privacy policy</footer>
          <script type="application/ld+json">{"@type":"BlogPosting"}</script>
        </body></html>`);
    }
  });
  const article = await new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  ).fetch(`${upstream.origin}/report`, AbortSignal.timeout(5000));
  assert.ok(article);
  assert.doesNotMatch(
    article.textContent,
    /Skip to content|Journal home|Privacy policy|BlogPosting/,
  );
  assert.match(article.textContent, /Read the field results/);
  assert.equal(article.markdown, markdown);
  assert.equal(article.title, 'Native field report');
  assert.equal(article.excerpt, 'Publisher summary');
  assert.equal(article.byline, 'Lina Haddad');
  assert.equal(article.publishedTime, '2026-10-24T09:00:00Z');
  assert.equal(article.canonicalUrl, `${upstream.origin}/report`);
  assert.equal(article.siteName, 'Field Journal');
  assert.equal(article.lang, 'en');
  assert.equal(article.dir, 'ltr');
  assert.equal(article.length, article.textContent.length);
  const content = JSDOM.fragment(article.content);
  assert.deepEqual(
    Array.from(content.querySelectorAll('td'), (cell) => cell.textContent),
    ['North', '7'],
  );
  assert.equal(content.querySelector('code')?.textContent, '  sample();');
  assert.equal(
    content.querySelector('a')?.getAttribute('href'),
    `${upstream.origin}/results`,
  );
});

test('unavailable or unreadable HTML companions preserve the complete native article', async () => {
  for (const mode of ['unavailable', 'empty', 'markdown', 'invalid-xhtml']) {
    await using upstream = await new HttpServer().start((request, response) => {
      if (request.headers.accept?.startsWith('text/markdown')) {
        response
          .writeHead(200, { 'content-type': 'text/markdown' })
          .end('# Native report\n\nA [brief finding](/finding).');
      } else if (mode === 'unavailable') response.writeHead(406).end();
      else if (mode === 'empty')
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<html><body></body></html>');
      else if (mode === 'markdown')
        response
          .writeHead(200, { 'content-type': 'text/markdown' })
          .end('# Wrong representation');
      else
        response
          .writeHead(200, { 'content-type': 'application/xhtml+xml' })
          .end('<html><unclosed>');
    });
    const article = await new WebArticle(
      [new MarkdownExtraction(), new HTMLExtraction()],
      got,
    ).fetch(upstream.origin, AbortSignal.timeout(5000));
    assert.ok(article);
    assert.equal(article.title, 'Native report');
    assert.equal(
      article.markdown,
      '# Native report\n\nA [brief finding](/finding).',
    );
    assert.match(article.textContent, /A brief finding/);
  }
});

test('cancellation during the HTML companion request preserves the original reason', async () => {
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  const reason = new Error('Stop the companion download');
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.headers.accept?.startsWith('text/markdown')) {
      response
        .writeHead(200, { 'content-type': 'text/markdown' })
        .end('# Native report\n\nA complete article.');
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.write('<html>');
      started.resolve();
    }
  });
  const pending = new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  ).fetch(
    upstream.origin,
    AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  );
  const rejected = assert.rejects(pending, (error) => error === reason);
  await started.promise;
  controller.abort(reason);
  await rejected;
});

test('advertised Markdown reuses its HTML page for isolation without overwriting native metadata', async () => {
  for (const viaHeader of [true, false]) {
    let htmlRequests = 0;
    await using upstream = await new HttpServer().start((request, response) => {
      if (request.url === '/story.md') {
        response
          .writeHead(200, { 'content-type': 'text/plain' })
          .end(
            '---\ntitle: Native title\nauthor: Native author\ndate: 2026-10-24\ndescription: Native summary\n---\n[Home](/)\n\nA [short linked post](/reference).\n\nSubscribe for updates.',
          );
      } else if (++htmlRequests === 1) {
        response.setHeader('content-type', 'text/html');
        if (viaHeader)
          response.setHeader(
            'link',
            '</story.md>; rel="alternate"; type="text/markdown"',
          );
        response.end(`<html><head><title>HTML title</title>
          <meta name="author" content="HTML author"><meta property="article:published_time" content="2026-10-20">
          <meta property="og:site_name" content="Field Journal">
          ${viaHeader ? '' : '<link rel="alternate" type="text/markdown" href="/story.md">'}
          </head><body><nav>Home</nav><article><p>A <a href="/reference">short linked post</a>.</p></article><footer>Subscribe for updates.</footer></body></html>`);
      } else response.writeHead(503).end();
    });
    const article = await new WebArticle(
      [new MarkdownExtraction(), new HTMLExtraction()],
      got,
    ).fetch(upstream.origin, AbortSignal.timeout(5000));
    assert.ok(article);
    assert.equal(
      article.textContent,
      `A short linked post [${upstream.origin}/reference].`,
    );
    assert.equal(article.title, 'Native title');
    assert.equal(article.byline, 'Native author');
    assert.equal(article.publishedTime, '2026-10-24');
    assert.equal(article.excerpt, 'Native summary');
    assert.equal(article.siteName, 'Field Journal');
    assert.equal(article.url, `${upstream.origin}/story.md`);
    assert.equal(
      article.markdown,
      '[Home](/)\n\nA [short linked post](/reference).\n\nSubscribe for updates.',
    );
  }
});
