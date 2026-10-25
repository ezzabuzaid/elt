import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import {
  ArticleError,
  type ArticlePage,
  HTMLExtraction,
  MarkdownExtraction,
  WebArticle,
} from './index.ts';

test('downloads defer real extraction and fingerprint revalidated bytes, redirects and charset', async () => {
  let revision = 1;
  let target = '/article';
  let contentType = 'text/html; charset=utf-8';
  let revalidated = 0;
  let extractions = 0;
  class CountedHTML extends HTMLExtraction {
    override async extract(page: ArticlePage, signal: AbortSignal) {
      extractions++;
      return super.extract(page, signal);
    }
  }
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/') {
      response.writeHead(302, { location: target }).end();
      return;
    }
    const etag = `"${revision}-${contentType}"`;
    response.setHeader('etag', etag);
    response.setHeader('cache-control', 'no-cache');
    if (request.headers['if-none-match'] === etag) {
      revalidated++;
      response.writeHead(304).end();
      return;
    }
    response.setHeader('content-type', contentType);
    response.end(
      `<article><p>Published report revision ${revision} contains the complete observations.</p></article>`,
    );
  });
  const http = got.extend({
    cache: new Map(),
    headers: { 'cache-control': 'no-cache' },
  });
  const signal = AbortSignal.timeout(10_000);
  const first = await new WebArticle([new CountedHTML()], http).download(
    upstream.origin,
    signal,
  );
  assert.equal(extractions, 0);
  assert(first.fingerprint);
  const article = await first.extract();
  assert(article);
  assert.equal(extractions, 1);
  const repeated = await new WebArticle([new CountedHTML()], http).download(
    upstream.origin,
    signal,
  );
  assert.equal(revalidated, 1);
  assert.equal(repeated.fingerprint, first.fingerprint);
  assert.equal(extractions, 1);
  const uncached = await new WebArticle([new CountedHTML()], got).download(
    upstream.origin,
    signal,
  );
  assert.equal(uncached.fingerprint, first.fingerprint);
  revision++;
  const edited = await new WebArticle([new CountedHTML()], http).download(
    upstream.origin,
    signal,
  );
  assert.notEqual(edited.fingerprint, first.fingerprint);
  contentType = 'text/html; charset=windows-1252';
  const charset = await new WebArticle([new CountedHTML()], http).download(
    upstream.origin,
    signal,
  );
  assert.notEqual(charset.fingerprint, edited.fingerprint);
  target = '/other';
  const redirected = await new WebArticle([new CountedHTML()], http).download(
    upstream.origin,
    signal,
  );
  assert.notEqual(redirected.fingerprint, charset.fingerprint);
  assert.equal(extractions, 1);
});

test('negotiated HTML is fingerprinted but independently changing alternatives remain eligible', async () => {
  let alternate = false;
  let revision = 1;
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/article.md') {
      response.setHeader('content-type', 'text/markdown');
      response.end(`# Report\n\nPublished revision ${revision}.`);
    } else {
      if (alternate)
        response.setHeader(
          'link',
          '</article.md>; rel="alternate"; type="text/markdown"',
        );
      response.setHeader('content-type', 'text/html');
      response.end(
        '<article><p>The HTML report remains unchanged.</p></article>',
      );
    }
  });
  const reader = new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  );
  const signal = AbortSignal.timeout(5000);
  assert((await reader.download(upstream.origin, signal)).fingerprint);
  alternate = true;
  const first = await reader.download(upstream.origin, signal);
  assert.equal(first.fingerprint, null);
  assert.match((await first.extract())?.markdown ?? '', /revision 1/);
  revision++;
  const second = await reader.download(upstream.origin, signal);
  assert.equal(second.fingerprint, null);
  assert.match((await second.extract())?.markdown ?? '', /revision 2/);
});

test('deferred extraction retains attributed failures and cancellation', async () => {
  const reason = new Error('Deliberate extraction failure');
  // A real HTML page cannot make the selector deliberately throw this error.
  class FailingHTML extends HTMLExtraction {
    protected override async select(): Promise<null> {
      throw reason;
    }
  }
  await using upstream = await new HttpServer().start((_request, response) => {
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<article><p>Readable report.</p></article>');
  });
  const controller = new AbortController();
  const download = await new WebArticle([new FailingHTML()], got).download(
    upstream.origin,
    controller.signal,
  );
  await assert.rejects(download.extract(), (error) => {
    assert(error instanceof ArticleError);
    assert.equal(error.url, `${upstream.origin}/`);
    assert.equal(error.cause, reason);
    return true;
  });
  controller.abort(reason);
  await assert.rejects(download.extract(), (error) => error === reason);
});

test('an unchanged rejected Markdown response cannot hide an edited HTML fallback', async () => {
  let revision = 1;
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.headers.accept?.startsWith('text/markdown')) {
      response.writeHead(200, { 'content-type': 'text/markdown' }).end('');
    } else {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(`<article><p>Fallback report revision ${revision}.</p></article>`);
    }
  });
  const reader = new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  );
  const signal = AbortSignal.timeout(5000);
  for (revision = 1; revision <= 2; revision++) {
    const download = await reader.download(upstream.origin, signal);
    assert.equal(download.fingerprint, null);
    assert.equal(
      (await download.extract())?.textContent,
      `Fallback report revision ${revision}.`,
    );
  }
});
