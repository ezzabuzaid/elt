import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import { HTMLExtraction, WebArticle } from './index.ts';

// Fortune's NewsArticle block, trimmed to the fields Readability reads; its
// @context is an array, as JSON-LD 1.1 allows.
const fortuneContext = [
  'https://schema.org',
  { stnMeta: { '@id': 'https://stnvideo.com', '@type': '@json' } },
];

test('the article date and headline come from JSON-LD whatever form its schema.org @context takes', async () => {
  for (const context of [
    'https://schema.org',
    fortuneContext,
    ['http://schema.org/'],
  ]) {
    await using upstream = await new HttpServer().start(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' }).end(`
        <html><head><title>Beef imports fall short | Fortune</title>
        <meta property="og:type" content="article">
        <script type="application/ld+json">${JSON.stringify({
          '@context': context,
          '@type': 'NewsArticle',
          headline: 'Beef imports at lower tariffs have lagged',
          datePublished: '2026-10-26T21:03:24-00:00',
          dateModified: '2026-10-27T15:44:00-00:00',
        })}</script></head><body><article>
          <h1>Beef imports at lower tariffs have lagged</h1>
          <p>Shipments have lagged and prices have not moved.</p>
        </article></body></html>`);
      },
    );

    const article = await new WebArticle([new HTMLExtraction()], got).fetch(
      upstream.origin,
      AbortSignal.timeout(5000),
    );

    assert.ok(article, JSON.stringify(context));
    assert.equal(
      article.publishedTime,
      '2026-10-26T21:03:24-00:00',
      JSON.stringify(context),
    );
    assert.equal(
      article.title,
      'Beef imports at lower tariffs have lagged',
      JSON.stringify(context),
    );
  }
});

test('a JSON-LD script that is not JSON leaves the article and the date of a valid script', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' }).end(`
      <html><head><title>Beef imports fall short | Fortune</title>
      <script type="application/ld+json">{"@context": ["https://schema.org",</script>
      <script type="application/ld+json">${JSON.stringify({
        '@context': fortuneContext,
        '@type': 'NewsArticle',
        headline: 'Beef imports at lower tariffs have lagged',
        datePublished: '2026-10-26T21:03:24-00:00',
      })}</script></head><body><article>
        <h1>Beef imports at lower tariffs have lagged</h1>
        <p>Shipments have lagged and prices have not moved.</p>
      </article></body></html>`);
  });

  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );

  assert.ok(article);
  assert.equal(article.publishedTime, '2026-10-26T21:03:24-00:00');
  assert.match(article.textContent, /Shipments have lagged/);
});
