import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';
import { JSDOM } from 'jsdom';

import { ArticleError, HTMLExtraction, WebArticle } from './index.ts';

test('one reader isolates redirected encoded articles, empty pages and failed pages', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '/');
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/article' }).end();
    } else if (request.url === '/article') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=iso-8859-1',
        'content-encoding': 'gzip',
      });
      response.end(
        gzipSync(
          Buffer.from(
            `<html lang="fr"><head>
        <title>Café report</title><link rel="canonical" href="/canonical#section">
        <meta name="author" content="Lina"><meta property="article:published_time" content="2026-10-20">
        </head><body><nav>Browse reports</nav><article>
        <p>Our café study confirms the <a href="/results">published results</a>.</p>
        <footer>Subscribe for offers.</footer></article></body></html>`,
            'latin1',
          ),
        ),
      );
    } else if (request.url === '/second') {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<html><head><title>Second report</title></head><body><article><p>The independent study confirms the observations.</p></article></body></html>',
      );
    } else if (request.url === '/empty') {
      response.setHeader('content-type', 'text/html');
      response.end('<nav><a href="/">Home</a></nav>');
    } else response.writeHead(404).end();
  });
  const reader = new WebArticle([new HTMLExtraction()], got);
  const signal = AbortSignal.timeout(5000);
  const [first, second, empty, failed] = await Promise.allSettled(
    ['/redirect', '/second', '/empty', '/missing'].map((path) =>
      reader.fetch(`${upstream.origin}${path}`, signal),
    ),
  );
  assert(first?.status === 'fulfilled' && first.value);
  const article = first.value;
  assert.equal(article.title, 'Café report');
  assert.equal(article.byline, 'Lina');
  assert.equal(article.publishedTime, '2026-10-20');
  assert.equal(article.lang, 'fr');
  assert.equal(article.url, `${upstream.origin}/article`);
  assert.equal(article.canonicalUrl, `${upstream.origin}/canonical`);
  assert.match(
    article.textContent,
    /Our café study confirms the published results/,
  );
  assert.equal(article.length, article.textContent.length);
  const content = JSDOM.fragment(article.content);
  assert.equal(
    content.querySelector('a')?.getAttribute('href'),
    `${upstream.origin}/results`,
  );
  assert.doesNotMatch(content.textContent ?? '', /Browse reports|Subscribe/);
  assert(second?.status === 'fulfilled' && second.value);
  assert.equal(second.value.title, 'Second report');
  assert.equal(second.value.publishedTime, null);
  assert.equal(second.value.canonicalUrl, null);
  assert.deepEqual(empty, { status: 'fulfilled', value: null });
  assert(failed?.status === 'rejected');
  assert(failed.reason instanceof ArticleError);
  assert.equal(failed.reason.url, `${upstream.origin}/missing`);
  assert.deepEqual(requests.toSorted(), [
    '/article',
    '/empty',
    '/missing',
    '/redirect',
    '/second',
  ]);
});
