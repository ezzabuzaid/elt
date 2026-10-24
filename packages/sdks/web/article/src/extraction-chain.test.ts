import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';
import type { JSDOM } from 'jsdom';

import {
  type Article,
  ArticleError,
  type ArticlePage,
  Extraction,
  HTMLExtraction,
  WebArticle,
} from './index.ts';

test('an article reader requires at least one extraction', () => {
  assert.throws(
    () => new WebArticle([], got),
    /At least one article extraction/,
  );
});

test('a non-HTML extraction receives response bytes and returns its article unchanged', async () => {
  let requests = 0;
  await using upstream = await new HttpServer().start((_request, response) => {
    requests++;
    response.setHeader('content-type', 'text/markdown; charset=utf-8');
    response.end('# Café report\n\nA **short** post.');
  });
  const article: Article = {
    url: `${upstream.origin}/`,
    canonicalUrl: null,
    title: 'Café report',
    byline: null,
    excerpt: 'A short post.',
    siteName: null,
    lang: null,
    dir: null,
    publishedTime: null,
    content: '<h1>Café report</h1><p>A <strong>short</strong> post.</p>',
    markdown: '# Café report\n\nA **short** post.',
    textContent: 'Café report\n\nA short post.',
    length: 26,
  };
  // Only HTML extraction ships; this stand-in exercises the public format extension.
  class MarkdownExtraction extends Extraction {
    override async extract(page: ArticlePage, signal: AbortSignal) {
      signal.throwIfAborted();
      assert.equal(page.url, `${upstream.origin}/`);
      assert.equal(page.contentType, 'text/markdown; charset=utf-8');
      assert(Buffer.isBuffer(page.body));
      assert.equal(page.body.toString(), '# Café report\n\nA **short** post.');
      return article;
    }
  }
  const result = await new WebArticle([new MarkdownExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(result, article);
  assert.equal(requests, 1);
});

// HTMLExtraction cannot deliberately reject a valid page or fail at a chosen
// point; test-local subclasses exercise that public extension boundary.
test('extractions run in order on fresh DOMs, download once and stop at the first article', async () => {
  let requests = 0;
  const attempts: string[] = [];
  class DecliningExtraction extends HTMLExtraction {
    protected override async select(dom: JSDOM) {
      attempts.push('decline');
      dom.window.document.body.replaceChildren();
      return null;
    }
  }
  class SelectedExtraction extends HTMLExtraction {
    protected override async select(dom: JSDOM, signal: AbortSignal) {
      attempts.push('html');
      return super.select(dom, signal);
    }
  }
  class UnreachedExtraction extends Extraction {
    override async extract(): Promise<never> {
      throw new Error('Extraction continued after an article was found');
    }
  }
  await using upstream = await new HttpServer().start((_request, response) => {
    requests++;
    response.setHeader('content-type', 'text/html');
    response.end(
      '<html><head><title>Field report</title></head><body><article><p>The independent study confirms the observations.</p></article></body></html>',
    );
  });
  const reader = new WebArticle(
    [
      new DecliningExtraction(),
      new SelectedExtraction(),
      new UnreachedExtraction(),
    ],
    got,
  );
  const article = await reader.fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.ok(article);
  assert.equal(article.title, 'Field report');
  assert.equal(
    article.markdown,
    'The independent study confirms the observations.',
  );
  assert.deepEqual(attempts, ['decline', 'html']);
  assert.equal(requests, 1);
});

test('exhausting the extraction array preserves an empty result without another download', async () => {
  let requests = 0;
  await using upstream = await new HttpServer().start((_request, response) => {
    requests++;
    response.setHeader('content-type', 'text/html');
    response.end('<nav><a href="/">Home</a></nav>');
  });
  const reader = new WebArticle(
    [new HTMLExtraction(), new HTMLExtraction()],
    got,
  );
  assert.equal(
    await reader.fetch(upstream.origin, AbortSignal.timeout(5000)),
    null,
  );
  assert.equal(requests, 1);
});

test('extraction failures and cancellation stop the chain and preserve their cause', async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const reason = new Error(
      cancelled ? 'Stop this extraction' : 'Cannot select this article',
    );
    class FailingExtraction extends HTMLExtraction {
      protected override async select(): Promise<null> {
        if (cancelled) {
          controller.abort(reason);
          return null;
        }
        throw reason;
      }
    }
    await using upstream = await new HttpServer().start(
      (_request, response) => {
        response.setHeader('content-type', 'text/html');
        response.end(
          '<article><p>The next extractor would accept this article.</p></article>',
        );
      },
    );
    const reader = new WebArticle(
      [new FailingExtraction(), new HTMLExtraction()],
      got,
    );
    await assert.rejects(
      reader.fetch(
        upstream.origin,
        AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      ),
      (error: unknown) => {
        if (cancelled) return error === reason;
        assert(error instanceof ArticleError);
        assert.equal(error.cause, reason);
        assert.equal(error.url, `${upstream.origin}/`);
        return true;
      },
    );
  }
});
