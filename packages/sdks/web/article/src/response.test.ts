import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got, { HTTPError } from 'got';

import {
  ArticleError,
  type ArticlePage,
  HTMLExtraction,
  MarkdownExtraction,
  WebArticle,
} from './index.ts';

test('reading a downloaded response reuses its original bytes and defers extraction', async () => {
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/start')
      response.writeHead(302, { location: '/report' }).end();
    else
      response
        .writeHead(200, { 'content-type': 'text/html; charset=windows-1252' })
        .end(Buffer.from('<article><p>A café report.</p></article>', 'latin1'));
  });
  const signal = AbortSignal.timeout(5000);
  const response = await got(`${upstream.origin}/start`, { signal });
  const originalBody = response.body;
  const extracted: ArticlePage[] = [];
  class CountedHTML extends HTMLExtraction {
    override async extract(page: ArticlePage, signal: AbortSignal) {
      extracted.push(page);
      return super.extract(page, signal);
    }
  }
  const reader = new WebArticle([new CountedHTML()], got);
  const download = await reader.read(response, signal);
  assert.equal(extracted.length, 0);
  assert.ok(download.fingerprint);
  const article = await download.extract();
  assert.equal(article?.url, `${upstream.origin}/report`);
  assert.equal(article?.textContent, 'A café report.');
  assert.equal(extracted[0]?.body, response.rawBody);
  assert.equal(response.body, originalBody);
  assert.deepEqual(requests, ['/start', '/report']);
  const fetched = await reader.download(`${upstream.origin}/start`, signal);
  assert.equal(fetched.fingerprint, download.fingerprint);
});

test('a supplied Markdown response requests its HTML companion in read() and fingerprints its changes', async () => {
  const requests: string[] = [];
  let revision = 1;
  await using upstream = await new HttpServer().start((request, response) => {
    assert.equal(request.headers['x-client'], 'shared');
    if (request.headers.accept?.startsWith('text/markdown')) {
      requests.push('markdown');
      response
        .writeHead(200, { 'content-type': 'text/markdown' })
        .end('# Native title\n\nPublisher content.');
    } else {
      requests.push('html');
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<meta name="author" content="Lina"><article><p>Companion revision ${revision}.</p></article>`,
        );
    }
  });
  const signal = AbortSignal.timeout(5000);
  const http = got.extend({ headers: { 'x-client': 'shared' } });
  const response = await http(upstream.origin, {
    signal,
    responseType: 'buffer',
    headers: { accept: 'text/markdown' },
  });
  const reader = new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    http,
  );
  const fingerprints = new Set<string>();
  for (revision = 1; revision <= 2; revision++) {
    const download = await reader.read(response, signal);
    assert(download.fingerprint);
    fingerprints.add(download.fingerprint);
    assert.equal(requests.length, revision + 1);
    const article = await download.extract();
    assert.equal(requests.length, revision + 1);
    assert.equal(article?.markdown, '# Native title\n\nPublisher content.');
    assert.equal(article?.title, 'Native title');
    assert.equal(article?.byline, 'Lina');
    assert.equal(article?.textContent, `Companion revision ${revision}.`);
  }
  assert.equal(fingerprints.size, 2);
  assert.deepEqual(requests, ['markdown', 'html', 'html']);
});

test('supplied HTML follows advertised Markdown and keeps the original HTML as its companion', async () => {
  for (const declaration of ['header', 'markup']) {
    const requests: string[] = [];
    await using upstream = await new HttpServer().start((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/native.md')
        response
          .writeHead(200, { 'content-type': 'text/markdown' })
          .end('# Native report\n\nOriginal Markdown.');
      else {
        if (declaration === 'header')
          response.setHeader(
            'link',
            '</native.md>; rel="alternate"; type="text/markdown"',
          );
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end(
            `${declaration === 'markup' ? '<link rel="alternate" type="text/markdown" href="/native.md">' : ''}<article><p>Readable HTML report.</p></article>`,
          );
      }
    });
    const signal = AbortSignal.timeout(5000);
    const response = await got(upstream.origin, { signal });
    const download = await new WebArticle(
      [new MarkdownExtraction(), new HTMLExtraction()],
      got,
    ).read(response, signal);
    assert(download.fingerprint);
    assert.deepEqual(requests, ['/', '/native.md']);
    const article = await download.extract();
    assert.equal(article?.url, `${upstream.origin}/native.md`);
    assert.equal(article?.markdown, '# Native report\n\nOriginal Markdown.');
    assert.equal(article?.textContent, 'Readable HTML report.');
    assert.deepEqual(requests, ['/', '/native.md']);
  }
});

test('supplied rejected and unreadable Markdown responses retain the HTML fallback', async () => {
  for (const mode of ['406', 'empty', 'malformed']) {
    const requests: string[] = [];
    await using upstream = await new HttpServer().start((request, response) => {
      if (request.headers.accept?.startsWith('text/markdown')) {
        requests.push('markdown');
        response
          .writeHead(mode === '406' ? 406 : 200, {
            'content-type': 'text/markdown',
          })
          .end(mode === 'malformed' ? '---\ntitle: [broken\n---\nBody' : '');
      } else {
        requests.push('html');
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<article><p>Readable fallback.</p></article>');
      }
    });
    const signal = AbortSignal.timeout(5000);
    const response = await got(upstream.origin, {
      signal,
      headers: { accept: 'text/markdown' },
      throwHttpErrors: false,
    });
    const download = await new WebArticle(
      [new MarkdownExtraction(), new HTMLExtraction()],
      got,
    ).read(response, signal);
    assert.equal((await download.extract())?.textContent, 'Readable fallback.');
    assert.deepEqual(requests, ['markdown', 'html']);
  }
});

test('supplied HTTP failures retain attribution and cancellation preserves the exact reason', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    response
      .writeHead(Number(request.url?.slice(1)), { 'content-type': 'text/html' })
      .end('<article><p>A complete report.</p></article>');
  });
  const signal = AbortSignal.timeout(5000);
  const reader = new WebArticle([new HTMLExtraction()], got);
  for (const status of [304, 404, 406, 500]) {
    const response = await got(`${upstream.origin}/${status}`, {
      signal,
      throwHttpErrors: false,
      retry: { limit: 0 },
    });
    await assert.rejects(reader.read(response, signal), (error) => {
      assert.ok(error instanceof ArticleError);
      assert.equal(error.url, response.url);
      assert.ok(error.cause instanceof HTTPError);
      assert.equal(error.cause.response, response);
      return true;
    });
  }
  const response = await got(`${upstream.origin}/200`, { signal });
  const controller = new AbortController();
  const download = await reader.read(response, controller.signal);
  const reason = new Error('Stop reading');
  controller.abort(reason);
  await assert.rejects(
    reader.read(response, controller.signal),
    (error) => error === reason,
  );
  await assert.rejects(download.extract(), (error) => error === reason);
});
