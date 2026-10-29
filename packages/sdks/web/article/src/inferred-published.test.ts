import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import { HTMLExtraction, WebArticle } from './index.ts';

// research.google/blog's markup, trimmed: the date is a paragraph in a block
// after the h1, and the page declares no date.
test('a date that the page shows only as text under its title is inferred, and publishedTime stays null', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' }).end(`
      <html><head><title>The sleep framework</title></head><body><main>
        <h1>The sleep framework</h1>
        <div><div><p>October 27, 2026</p><span></span><p>Ali Behrouz and Vahab Mirrokni, Google Research</p></div></div>
        <p>Continual learning lets a model keep what it learned before.</p>
      </main></body></html>`);
  });

  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );

  assert.ok(article);
  assert.equal(article.publishedTime, null);
  assert.equal(article.inferredPublished, '2026-10-27T00:00:00.000Z');
});

// ai.meta.com/blog's markup, trimmed: the date is a span in a block after the h1.
test('a date in a span beside the title is inferred', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' }).end(`
      <html><head><title>Introducing Muse Spark 1.1</title></head><body><main>
        <h1><span>Introducing Muse Spark 1.1</span></h1>
        <div><span>July 9, 2026</span><span>•</span><div><span>10 minute read</span></div></div>
        <p>Muse Spark 1.1 is now in the Meta model API.</p>
      </main></body></html>`);
  });

  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );

  assert.ok(article);
  assert.equal(article.publishedTime, null);
  assert.equal(article.inferredPublished, '2026-07-09T00:00:00.000Z');
});

test('a declared date wins over a different date in the text, in publishedTime and in the inferred date', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' }).end(`
      <html><head><title>The sleep framework</title>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: 'The sleep framework',
        datePublished: '2026-10-26T21:03:24-02:00',
      })}</script></head><body><main>
        <h1>The sleep framework</h1>
        <div><p>October 27, 2026</p></div>
        <p>Continual learning lets a model keep what it learned before.</p>
      </main></body></html>`);
  });

  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );

  assert.ok(article);
  assert.equal(article.publishedTime, '2026-10-26T21:03:24-02:00');
  assert.equal(article.inferredPublished, '2026-10-26T23:03:24.000Z');
});

test('a page that shows no date has no publishedTime and no inferred date', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' }).end(`
      <html><head><title>The sleep framework</title></head><body><main>
        <h1>The sleep framework</h1>
        <div><p>Ali Behrouz and Vahab Mirrokni, Google Research</p></div>
        <p>Continual learning lets a model keep what it learned before.</p>
      </main></body></html>`);
  });

  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );

  assert.ok(article);
  assert.equal(article.publishedTime, null);
  assert.equal(article.inferredPublished, null);
});
