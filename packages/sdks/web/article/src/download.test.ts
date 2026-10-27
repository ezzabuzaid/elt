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

test('native Markdown is fingerprinted with its HTML companion, which read() requests and extract() reuses', async () => {
  const requests: string[] = [];
  let markdown = 1;
  let html = 1;
  let companion = true;
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.headers.accept?.startsWith('text/markdown')) {
      requests.push('markdown');
      response
        .writeHead(200, { 'content-type': 'text/markdown' })
        .end(`# Report\n\nMarkdown revision ${markdown}.`);
    } else {
      requests.push('html');
      if (companion)
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end(
            `<meta name="author" content="Lina"><article><p>HTML revision ${html}.</p></article>`,
          );
      else response.writeHead(404).end();
    }
  });
  const reader = new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  );
  const signal = AbortSignal.timeout(5000);
  const first = await reader.download(upstream.origin, signal);
  assert(first.fingerprint);
  assert.deepEqual(requests, ['markdown', 'html']);
  const article = await first.extract();
  assert.equal(article?.markdown, '# Report\n\nMarkdown revision 1.');
  assert.equal(article?.byline, 'Lina');
  assert.equal(article?.textContent, 'HTML revision 1.');
  assert.deepEqual(requests, ['markdown', 'html']);
  const unchanged = await reader.download(upstream.origin, signal);
  assert.equal(unchanged.fingerprint, first.fingerprint);
  html++;
  const editedHTML = await reader.download(upstream.origin, signal);
  assert(editedHTML.fingerprint);
  assert.notEqual(editedHTML.fingerprint, first.fingerprint);
  markdown++;
  const editedMarkdown = await reader.download(upstream.origin, signal);
  assert(editedMarkdown.fingerprint);
  assert.notEqual(editedMarkdown.fingerprint, editedHTML.fingerprint);
  companion = false;
  requests.length = 0;
  const missing = await reader.download(upstream.origin, signal);
  assert(missing.fingerprint);
  assert.notEqual(missing.fingerprint, editedMarkdown.fingerprint);
  assert.equal(
    (await reader.download(upstream.origin, signal)).fingerprint,
    missing.fingerprint,
  );
  const native = await missing.extract();
  assert.equal(native?.markdown, '# Report\n\nMarkdown revision 2.');
  assert.equal(native?.byline, null);
  assert.deepEqual(requests, ['markdown', 'html', 'markdown', 'html']);
});

test('an HTML page is fingerprinted with its advertised Markdown alternate, which read() requests and extract() reuses', async () => {
  const requests: string[] = [];
  let alternate: 'none' | 'available' | 'missing' = 'none';
  let markdown = 1;
  let html = 1;
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/article.md') {
      if (alternate === 'missing') response.writeHead(404).end();
      else
        response
          .writeHead(200, { 'content-type': 'text/markdown' })
          .end(`# Report\n\nMarkdown revision ${markdown}.`);
    } else {
      if (alternate !== 'none')
        response.setHeader(
          'link',
          '</article.md>; rel="alternate"; type="text/markdown"',
        );
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(`<article><p>HTML revision ${html}.</p></article>`);
    }
  });
  const reader = new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  );
  const signal = AbortSignal.timeout(5000);
  const plain = await reader.download(upstream.origin, signal);
  assert(plain.fingerprint);
  alternate = 'available';
  requests.length = 0;
  const first = await reader.download(upstream.origin, signal);
  assert(first.fingerprint);
  assert.notEqual(first.fingerprint, plain.fingerprint);
  assert.deepEqual(requests, ['/', '/article.md']);
  const article = await first.extract();
  assert.equal(article?.markdown, '# Report\n\nMarkdown revision 1.');
  assert.equal(article?.textContent, 'HTML revision 1.');
  assert.deepEqual(requests, ['/', '/article.md']);
  const unchanged = await reader.download(upstream.origin, signal);
  assert.equal(unchanged.fingerprint, first.fingerprint);
  markdown++;
  const editedMarkdown = await reader.download(upstream.origin, signal);
  assert(editedMarkdown.fingerprint);
  assert.notEqual(editedMarkdown.fingerprint, first.fingerprint);
  html++;
  const editedHTML = await reader.download(upstream.origin, signal);
  assert(editedHTML.fingerprint);
  assert.notEqual(editedHTML.fingerprint, editedMarkdown.fingerprint);
  alternate = 'missing';
  const missing = await reader.download(upstream.origin, signal);
  assert(missing.fingerprint);
  assert.notEqual(missing.fingerprint, editedHTML.fingerprint);
  assert.equal(
    (await reader.download(upstream.origin, signal)).fingerprint,
    missing.fingerprint,
  );
  assert.equal((await missing.extract())?.markdown, 'HTML revision 2.');
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
  const fingerprints = new Set<string>();
  for (revision = 1; revision <= 2; revision++) {
    const download = await reader.download(upstream.origin, signal);
    assert(download.fingerprint);
    fingerprints.add(download.fingerprint);
    assert.equal(
      (await download.extract())?.textContent,
      `Fallback report revision ${revision}.`,
    );
  }
  assert.equal(fingerprints.size, 2);
});
