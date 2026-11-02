import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import { HTMLExtraction, MarkdownExtraction, WebArticle } from './index.ts';

test("an HTML page's localized versions are the language copies that its head and its Link header declare, itself included, resolved, without fragments and without repeats", async () => {
  // The head of aws.amazon.com/de/training/startups/ on 2026-11-02, trimmed.
  await using upstream = await new HttpServer().start((request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html',
      link: '</training/startups/>; rel="alternate"; hreflang="en-US", </ja/training/startups/>; rel="alternate"; hreflang="ja-jp"',
    }).end(`<html lang="de"><head><title>AWS für Startups</title>
<link rel="alternate" href="/training/startups/" hreflang="en-us">
<link rel="alternate" href="/de/training/startups/#top" hreflang="de-de">
<link rel="alternate" href="/es/training/startups/" hreflang="es-es">
<link rel="alternate" href="/feed.xml" type="application/rss+xml">
<link rel="alternate" href="mailto:startups@example.com" hreflang="fr-fr">
</head><body><article><p>Schulungen und Ressourcen für Startups, die auf AWS aufbauen.</p></article></body></html>`);
  });

  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    `${upstream.origin}/de/training/startups/`,
    AbortSignal.timeout(5000),
  );

  assert.ok(article);
  assert.deepEqual(article.localizedVersions, [
    { language: 'en-us', url: `${upstream.origin}/training/startups/` },
    { language: 'de-de', url: `${upstream.origin}/de/training/startups/` },
    { language: 'es-es', url: `${upstream.origin}/es/training/startups/` },
    { language: 'ja-jp', url: `${upstream.origin}/ja/training/startups/` },
  ]);
});

test('a page whose head declares no canonical URL takes the one of its Link header, and a canonical URL in its head wins over the header', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    const head =
      request.url === '/declared'
        ? '<link rel="canonical" href="/from-head">'
        : '';
    response
      .writeHead(200, {
        'content-type': 'text/html',
        link: '</from-header>; rel="canonical"',
      })
      .end(
        `<html><head><title>Report</title>${head}</head><body><article><p>The field study confirms the published observations.</p></article></body></html>`,
      );
  });
  const reader = new WebArticle([new HTMLExtraction()], got);

  const undeclared = await reader.fetch(
    `${upstream.origin}/undeclared`,
    AbortSignal.timeout(5000),
  );
  const declared = await reader.fetch(
    `${upstream.origin}/declared`,
    AbortSignal.timeout(5000),
  );

  assert.equal(undeclared?.canonicalUrl, `${upstream.origin}/from-header`);
  assert.equal(declared?.canonicalUrl, `${upstream.origin}/from-head`);
});

test('a native Markdown page, which has no head, takes its canonical URL and its localized versions from its Link header', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    response
      .writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        link: '</report>; rel="canonical", </report>; rel="alternate"; hreflang="en", </de/report>; rel="alternate"; hreflang="de"',
      })
      .end(
        '# Field report\n\nThe field study confirms the published observations.\n',
      );
  });

  const article = await new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  ).fetch(`${upstream.origin}/report.md`, AbortSignal.timeout(5000));

  assert.ok(article);
  assert.equal(article.canonicalUrl, `${upstream.origin}/report`);
  assert.deepEqual(article.localizedVersions, [
    { language: 'en', url: `${upstream.origin}/report` },
    { language: 'de', url: `${upstream.origin}/de/report` },
  ]);
});
