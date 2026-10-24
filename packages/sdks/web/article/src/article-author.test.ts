import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import { HTMLExtraction, WebArticle } from './index.ts';

test('publication datelines do not become authors or erase dates mentioned in prose', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' }).end(`
      <html><head><title>Field notes</title></head><body><article>
        <h1>Field notes</h1>
        <h6 class="dateline">Wednesday, 21 October 2026</h6>
        <p>Read the <a href="/study">field study</a>.</p>
        <p>Measurements began on 21 October 2026.</p>
      </article></body></html>`);
  });
  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.ok(article);
  assert.equal(article.byline, null);
  assert.equal(article.publishedTime, null);
  assert.match(article.textContent, /Measurements began on 21 October 2026/);
  assert.match(article.markdown, /Measurements began on 21 October 2026/);
  assert.match(article.textContent, /Read the field study/);
});

test('author metadata and author markup survive dateline normalization', async () => {
  for (const { head, byline, expected } of [
    { head: '<meta name="author" content="May">', byline: '', expected: 'May' },
    {
      head: '<meta name="author" content="Fallback name"><script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Field notes","author":[{"@type":"Person","name":"Lina"},{"@type":"Person","name":"Omar"}]}</script>',
      byline: '',
      expected: 'Lina, Omar',
    },
    {
      head: '',
      byline:
        '<div class="post-dateline"><time>21 October 2026</time><span rel="author">Lina Haddad</span></div>',
      expected: 'Lina Haddad',
    },
    {
      head: '',
      byline: '<p class="dateline-author">June Brown</p>',
      expected: 'June Brown',
    },
    {
      head: '',
      byline: '<p class="dateline p-author">Lina Haddad</p>',
      expected: 'Lina Haddad',
    },
    {
      head: '',
      byline:
        '<div id="dateline" itemprop="author"><span itemprop="name">Lina Haddad</span></div>',
      expected: 'Lina Haddad',
    },
    {
      head: '',
      byline: '<p class="byline">By Lina Haddad</p>',
      expected: 'By Lina Haddad',
    },
  ]) {
    await using upstream = await new HttpServer().start(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' }).end(`
        <html><head><title>Field notes</title>${head}</head><body><article>
          <h1>Field notes</h1><h6 class="dateline">Wednesday, 21 October 2026</h6>
          ${byline}<p>Read the <a href="/study">field study</a>.</p>
        </article></body></html>`);
      },
    );
    const article = await new WebArticle([new HTMLExtraction()], got).fetch(
      upstream.origin,
      AbortSignal.timeout(5000),
    );
    assert.ok(article);
    assert.equal(article.byline, expected);
    assert.equal(article.publishedTime, null);
    assert.match(article.textContent, /Read the field study/);
  }
});

test('dateline hints in IDs and composite class names do not label localized dates as authors', async () => {
  for (const { attributes, date } of [
    { attributes: 'id="dateline"', date: 'mercredi 21 octobre 2026' },
    { attributes: 'class="post-dateLine muted"', date: '٢١ أكتوبر ٢٠٢٦' },
    { attributes: 'id="postDATELINE"', date: 'London — 21 October 2026' },
    { attributes: 'class="bydatelineline"', date: '21 October 2026' },
  ]) {
    await using upstream = await new HttpServer().start(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' }).end(`
        <html><head><title>Field notes</title></head><body><article>
          <h1>Field notes</h1><p ${attributes}>${date}</p>
          <p>Read the <a href="/study">field study</a>.</p>
        </article></body></html>`);
      },
    );
    const article = await new WebArticle([new HTMLExtraction()], got).fetch(
      upstream.origin,
      AbortSignal.timeout(5000),
    );
    assert.ok(article);
    assert.equal(article.byline, null);
    assert.equal(article.publishedTime, null);
    assert.match(article.textContent, /Read the field study/);
  }
});
