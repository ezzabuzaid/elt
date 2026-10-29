import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import { HTMLExtraction, WebArticle } from './index.ts';

// cerebras.ai/blog's markup, trimmed: every post declares only the site's
// name as its title, and the real title is the page's one h1. The <base>
// gives the page cerebras.ai's address, as the local server's is 127.0.0.1.
test("a page that declares only the site's name as its title takes the title of its one h1", async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' }).end(`
      <html><head><base href="https://www.cerebras.ai/blog/moe-guide-scale"><title>Cerebras</title>
      <meta property="og:title" content="Cerebras">
      <meta name="twitter:title" content="Cerebras">
      </head><body><main>
        <p>Aug 18 2026</p>
        <h1>MoE at Scale: Making Sparse Models Fast on Real Hardware</h1>
        <p>Mixture-of-experts models activate only a few experts for each token, so a 47-billion-parameter model can run like a 13-billion-parameter one.</p>
        <p>This guide shows how expert parallelism maps onto real hardware.</p>
      </main></body></html>`);
  });

  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );

  assert.ok(article);
  assert.equal(
    article.title,
    'MoE at Scale: Making Sparse Models Fast on Real Hardware',
  );
});

test('a short declared title stays when the page has more than one h1', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' }).end(`
      <html><head><title>Voxtral 3</title>
      <meta property="og:title" content="Voxtral 3">
      </head><body><main>
        <h1>Voxtral 3</h1>
        <p>Voxtral 3 transcribes speech in 40 languages and runs on one GPU.</p>
        <h1>Pricing</h1>
        <p>The model costs $0.001 per minute of audio.</p>
      </main></body></html>`);
  });

  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );

  assert.ok(article);
  assert.equal(article.title, 'Voxtral 3');
});
