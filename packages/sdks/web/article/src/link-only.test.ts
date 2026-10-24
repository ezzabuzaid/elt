import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import { HTMLExtraction, WebArticle } from './index.ts';

test('unmarked link-only navigation returns no article', async () => {
  // A local page reproduces the reported markup without publisher changes.
  for (const html of [
    '<html><body><div><a href="/">Home</a><a href="/login">Log in</a></div></body></html>',
    '<html><body><ul><li><a href="/">Accueil</a></li><li><a href="/login">Connexion</a></li></ul></body></html>',
    '<html><body><div>\n&nbsp;<span><a href="/">Home</a></span>\t<span><a href="/login">Log in</a></span> </div></body></html>',
  ]) {
    const upstream = await new HttpServer().start((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(html);
    });

    try {
      const article = await new WebArticle([new HTMLExtraction()], got).fetch(
        upstream.origin,
        AbortSignal.timeout(5000),
      );

      assert.equal(article, null);
    } finally {
      await upstream[Symbol.asyncDispose]();
    }
  }
});

test('a short linked post needs no article markup or minimum prose length', async () => {
  const upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(
      '<html><body><div>See <a href="/results">the complete results from our garden study</a>.</div></body></html>',
    );
  });

  try {
    const article = await new WebArticle([new HTMLExtraction()], got).fetch(
      upstream.origin,
      AbortSignal.timeout(5000),
    );

    assert.ok(article);
    assert.equal(
      article.textContent,
      `See the complete results from our garden study [${upstream.origin}/results].`,
    );
    assert.ok(article.content.includes(`href="${upstream.origin}/results"`));
  } finally {
    await upstream[Symbol.asyncDispose]();
  }
});

test('declared articles retain posts consisting entirely of links', async () => {
  for (const html of [
    '<html><body><article><p><a href="/first">First finding</a> <a href="/second">Second finding</a></p></article></body></html>',
    '<html><body><div role="article"><p><a href="/first">First finding</a> <a href="/second">Second finding</a></p></div></body></html>',
  ]) {
    const upstream = await new HttpServer().start((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(html);
    });

    try {
      const article = await new WebArticle([new HTMLExtraction()], got).fetch(
        upstream.origin,
        AbortSignal.timeout(5000),
      );

      assert.ok(article);
      assert.equal(
        article.textContent,
        `First finding [${upstream.origin}/first] Second finding [${upstream.origin}/second]`,
      );
      assert.ok(article.content.includes(`href="${upstream.origin}/first"`));
      assert.ok(article.content.includes(`href="${upstream.origin}/second"`));
    } finally {
      await upstream[Symbol.asyncDispose]();
    }
  }
});

test('a standalone table retains cells whose entire contents are links', async () => {
  const upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<html><body><table>
      <tr><th><a href="/season">Season</a></th><th><a href="/rainfall">Rainfall</a></th></tr>
      <tr><td><strong><a href="/spring">Spring</a></strong></td><td><a href="/37">37 mm</a></td></tr>
      <tr><td><a href="/autumn">Autumn</a></td><td><a href="/52">52 mm</a></td></tr>
    </table></body></html>`);
  });

  try {
    const article = await new WebArticle([new HTMLExtraction()], got).fetch(
      upstream.origin,
      AbortSignal.timeout(5000),
    );

    assert.ok(article);
    assert.match(article.textContent, /Spring.*37 mm/);
    assert.match(article.textContent, /Autumn.*52 mm/);
    assert.ok(article.content.includes(`href="${upstream.origin}/spring"`));
    assert.ok(article.content.includes(`href="${upstream.origin}/37"`));
  } finally {
    await upstream[Symbol.asyncDispose]();
  }
});
