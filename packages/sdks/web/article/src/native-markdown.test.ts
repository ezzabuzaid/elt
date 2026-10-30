import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got, { HTTPError } from 'got';
import { JSDOM } from 'jsdom';

import {
  ArticleError,
  HTMLExtraction,
  MarkdownExtraction,
  WebArticle,
} from './index.ts';

test('the configured extraction order requests native Markdown before HTML and keeps HTML-only readers working', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.headers.accept?.startsWith('text/markdown')) {
      response.setHeader('content-type', 'text/markdown; charset=utf-8');
      response.end('# Native version\n\nPublisher-provided content.');
    } else {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<html><head><title>HTML version</title></head><body><article><p>HTML fallback content.</p></article></body></html>',
      );
    }
  });
  const native = await new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  ).fetch(upstream.origin, AbortSignal.timeout(5000));
  assert.equal(
    native?.markdown,
    '# Native version\n\nPublisher-provided content.',
  );
  const html = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.equal(html?.title, 'HTML version');
  assert.match(html?.textContent ?? '', /HTML fallback content/);
});

test('native Markdown with a stylesheet jsdom cannot parse writes nothing to the console', async (t) => {
  // Markdown may carry raw HTML; a stray closing brace in its style element
  // is "Could not parse CSS stylesheet" to jsdom.
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.headers.accept?.startsWith('text/markdown')) {
      response.setHeader('content-type', 'text/markdown; charset=utf-8');
      response.end(
        '# Startups\n\n<style>.a{color:red}}</style>\n\nGet up to $100,000 in credits for your first year.',
      );
    } else {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<html><head><title>Startups</title></head><body><article><p>Get up to $100,000 in credits for your first year.</p></article></body></html>',
      );
    }
  });
  const errors = t.mock.method(console, 'error', () => {});

  const article = await new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  ).fetch(upstream.origin, AbortSignal.timeout(5000));

  assert.match(article?.markdown ?? '', /\$100,000 in credits/);
  assert.deepEqual(
    errors.mock.calls.map(({ arguments: [message] }) => message),
    [],
  );
});

test('native Markdown retains its source, tables, linked prose and code while producing safe HTML', async () => {
  const markdown =
    '# Café report\n\nRead the [results](/results).\n\n| Item | Count |\n| --- | --- |\n| Tea | 2 |\n\n```js\n  a < b;\n```\n\n<script>alert(1)</script>\n';
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/markdown; charset=utf-8');
    response.end(markdown);
  });
  const article = await new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  ).fetch(upstream.origin, AbortSignal.timeout(5000));
  assert.ok(article);
  assert.equal(article.markdown, markdown);
  assert.equal(article.title, 'Café report');
  assert.equal(article.url, `${upstream.origin}/`);
  assert.equal(article.publishedTime, null);
  assert.equal(article.canonicalUrl, null);
  const content = JSDOM.fragment(article.content);
  assert.equal(
    content.querySelector('a')?.getAttribute('href'),
    `${upstream.origin}/results`,
  );
  assert.deepEqual(
    Array.from(content.querySelectorAll('td'), (cell) => cell.textContent),
    ['Tea', '2'],
  );
  assert.equal(content.querySelector('code')?.textContent, '  a < b;\n');
  assert.equal(content.querySelector('script'), null);
  assert.doesNotMatch(article.textContent, /alert\(1\)/);
  assert.match(article.textContent, /Tea\s+2/);
});

test('native front matter supplies metadata without becoming article prose or coercing publication dates', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/markdown; charset=iso-8859-1');
    response.end(
      Buffer.from(
        '---\ntitle: Café metadata\nauthor: Lina\ndate: 2026-10-24\ndescription: Recorded observations\n---\n\n# Visible heading\n\nA short café report.\n',
        'latin1',
      ),
    );
  });
  const article = await new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  ).fetch(upstream.origin, AbortSignal.timeout(5000));
  assert.ok(article);
  assert.equal(article.title, 'Café metadata');
  assert.equal(article.byline, 'Lina');
  assert.equal(article.publishedTime, '2026-10-24');
  assert.equal(article.excerpt, 'Recorded observations');
  assert.doesNotMatch(article.content, /title:|date:|Recorded observations/);
  assert.equal(
    article.markdown,
    '\n# Visible heading\n\nA short café report.\n',
  );
});

test('advertised Markdown alternatives outrank HTML through HTTP Link and HTML link declarations', async () => {
  for (const viaHeader of [true, false]) {
    for (const contentType of [
      'text/markdown; charset=utf-8',
      'text/plain; charset=utf-8',
    ]) {
      await using upstream = await new HttpServer().start(
        (request, response) => {
          if (request.url === '/start') {
            response.writeHead(302, { location: '/posts/story' }).end();
          } else if (request.url === '/posts/story') {
            response.setHeader('content-type', 'text/html');
            if (viaHeader)
              response.setHeader(
                'link',
                '<../native/story.md>; rel="alternate"; type="text/markdown; charset=utf-8"',
              );
            response.end(
              `<html><head><title>HTML fallback</title>${viaHeader ? '' : '<base href="/native/"><link rel="alternate" type="text/markdown" href="story.md">'}</head><body><article><p>The fallback article remains available.</p></article></body></html>`,
            );
          } else if (request.url === '/native/story.md') {
            response.setHeader('content-type', contentType);
            response.end(
              '# Native alternative\n\nThe publisher-selected representation.',
            );
          } else response.writeHead(404).end();
        },
      );
      const article = await new WebArticle(
        [new MarkdownExtraction(), new HTMLExtraction()],
        got,
      ).fetch(`${upstream.origin}/start`, AbortSignal.timeout(5000));
      assert.equal(article?.title, 'Native alternative');
      assert.equal(article?.url, `${upstream.origin}/native/story.md`);
      assert.equal(
        article?.markdown,
        '# Native alternative\n\nThe publisher-selected representation.',
      );
    }
  }
});

test('unavailable, malformed and misleading Markdown alternatives preserve the original HTML article', async () => {
  for (const alternative of ['missing', 'empty', 'invalid', 'html']) {
    await using upstream = await new HttpServer().start((request, response) => {
      if (request.url === '/story') {
        response.setHeader('content-type', 'text/html');
        response.setHeader(
          'link',
          '</alternate>; rel="alternate"; type="text/markdown", </story#again>; rel="alternate"; type="text/markdown"',
        );
        response.end(
          '<html><head><title>Original article</title></head><body><article><p>Keep this complete fallback article.</p></article></body></html>',
        );
      } else if (alternative === 'missing') response.writeHead(404).end();
      else if (alternative === 'html')
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<h1>Misleading alternate</h1>');
      else
        response
          .writeHead(200, { 'content-type': 'text/markdown' })
          .end(alternative === 'empty' ? '' : '---\ntitle: [broken\n---\nBody');
    });
    const article = await new WebArticle(
      [new MarkdownExtraction(), new HTMLExtraction()],
      got,
    ).fetch(`${upstream.origin}/story`, AbortSignal.timeout(5000));
    assert.equal(article?.title, 'Original article');
    assert.equal(article?.url, `${upstream.origin}/story`);
    assert.match(article?.textContent ?? '', /complete fallback article/);
  }
});

test('negotiated Markdown rejection or unreadable content retries the same page as HTML', async () => {
  for (const mode of ['406', 'empty', 'invalid']) {
    await using upstream = await new HttpServer().start((request, response) => {
      if (request.headers.accept?.startsWith('text/markdown')) {
        if (mode === '406') response.writeHead(406).end();
        else
          response
            .writeHead(200, { 'content-type': 'text/markdown' })
            .end(mode === 'empty' ? '' : '---\ntitle: [broken\n---\nBody');
      } else
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end(
            '<html><head><title>Readable fallback</title></head><body><article><p>The page remains readable as HTML.</p></article></body></html>',
          );
    });
    const article = await new WebArticle(
      [new MarkdownExtraction(), new HTMLExtraction()],
      got,
    ).fetch(upstream.origin, AbortSignal.timeout(5000));
    assert.equal(article?.title, 'Readable fallback');
    assert.match(article?.textContent ?? '', /remains readable as HTML/);
  }
});

test('a Markdown request that a site redirects to an HTML app shell, saying Vary: Accept, gives the page a browser gets under its own URL', async () => {
  // linear.app on 2026-10-30, trimmed: a Markdown request is sent to
  // /index.md, which answers every request with the app's loading shell.
  await using upstream = await new HttpServer().start((request, response) => {
    if (
      request.url === '/' &&
      request.headers.accept?.startsWith('text/markdown')
    )
      response.writeHead(307, { location: '/index.md', vary: 'Accept' }).end();
    else if (request.url === '/')
      response
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          link: '</index.md>; rel="alternate"; type="text/markdown"',
        })
        .end(
          '<!doctype html><html lang="en"><head><title>Linear – The system for product development</title></head><body><main><h1>The product development system for teams and agents</h1><p>Purpose-built for planning and building products. Designed for the AI era.</p></main></body></html>',
        );
    else if (request.url === '/index.md')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Linear</title></head><body><div id="root"></div><div id="loading"><div id="loading-content">Loading…</div></div></body></html>',
        );
    else response.writeHead(404).end();
  });

  const article = await new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  ).fetch(`${upstream.origin}/`, AbortSignal.timeout(5000));

  assert.equal(article?.url, `${upstream.origin}/`);
  assert.equal(article?.title, 'Linear – The system for product development');
  assert.match(
    article?.textContent ?? '',
    /Purpose-built for planning and building products/,
  );
});

test('a redirect that Vary says Accept chose but that sends a browser to the same page asks the page once more as a browser, and no more', async () => {
  // www.notion.so/startups on 2026-10-30: a move to another address that varies on Accept.
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(
      `${request.url} ${request.headers.accept?.startsWith('text/markdown') ? 'markdown' : 'html'}`,
    );
    if (request.url === '/startups')
      response
        .writeHead(301, {
          location: '/new/startups',
          vary: 'Accept, Accept-Encoding',
        })
        .end();
    else
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<html><head><title>Notion for Startups</title></head><body><article><p>Startups get Notion with credits for their whole team.</p></article></body></html>',
        );
  });

  const article = await new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  ).fetch(`${upstream.origin}/startups`, AbortSignal.timeout(5000));

  assert.equal(article?.url, `${upstream.origin}/new/startups`);
  assert.equal(article?.title, 'Notion for Startups');
  assert.deepEqual(requests, [
    '/startups markdown',
    '/new/startups markdown',
    '/startups html',
    '/new/startups html',
  ]);
});

test('a page asked again as a browser after a failed Markdown redirect still prefers the Markdown it advertises', async () => {
  // No site seen on 2026-10-30 does both: this one stands for a site whose
  // Accept redirect fails while the Markdown that its page advertises works.
  await using upstream = await new HttpServer().start((request, response) => {
    if (
      request.url === '/guide' &&
      request.headers.accept?.startsWith('text/markdown')
    )
      response.writeHead(307, { location: '/guide.md', vary: 'Accept' }).end();
    else if (request.url === '/guide')
      response
        .writeHead(200, {
          'content-type': 'text/html',
          link: '</docs/guide.md>; rel="alternate"; type="text/markdown"',
        })
        .end(
          '<html><head><title>HTML guide</title></head><body><article><p>The guide as HTML.</p></article></body></html>',
        );
    else if (request.url === '/guide.md')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<html><head><title>App</title></head><body><div id="loading">Loading…</div></body></html>',
        );
    else if (request.url === '/docs/guide.md')
      response
        .writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
        .end('# Native guide\n\nThe publisher-selected representation.');
    else response.writeHead(404).end();
  });

  const article = await new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  ).fetch(`${upstream.origin}/guide`, AbortSignal.timeout(5000));

  assert.equal(article?.title, 'Native guide');
  assert.equal(
    article?.markdown,
    '# Native guide\n\nThe publisher-selected representation.',
  );
});

test('a Markdown request that Accept redirects to Markdown is read as Markdown without asking the page as a browser', async () => {
  // linear.app/docs/mcp on 2026-10-30, trimmed.
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    const markdown = request.headers.accept?.startsWith('text/markdown');
    requests.push(`${request.url} ${markdown ? 'markdown' : 'html'}`);
    if (request.url === '/docs/mcp' && markdown)
      response
        .writeHead(307, { location: '/docs/mcp.md', vary: 'Accept' })
        .end();
    else if (request.url === '/docs/mcp')
      response
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          vary: 'Accept, Accept-Encoding',
        })
        .end(
          '<html><head><title>MCP server – Linear Docs</title></head><body><article><p>The MCP server as HTML.</p></article></body></html>',
        );
    else if (request.url === '/docs/mcp.md')
      response
        .writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
        .end(
          '# MCP server\n\nConnect to the Linear MCP server at https://mcp.linear.app/mcp to read and change issues, projects, and documents.',
        );
    else response.writeHead(404).end();
  });

  const article = await new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  ).fetch(`${upstream.origin}/docs/mcp`, AbortSignal.timeout(5000));

  assert.equal(article?.title, 'MCP server');
  assert.deepEqual(
    requests.filter((request) => request.startsWith('/docs/mcp ')),
    ['/docs/mcp markdown'],
  );
});

test('a redirect whose Vary names only other headers is not asked again', async () => {
  // www.zendesk.com/startups/ and www.cloudflare.com/forstartups/ on 2026-10-30 vary on
  // accept-encoding; other sites vary on Accept-Language.
  const requests: string[] = [];
  await using upstream = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/startups/')
      response
        .writeHead(301, {
          location: '/business/startups/',
          vary: 'accept-encoding, Accept-Language',
        })
        .end();
    else
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<html><head><title>Zendesk for Startups</title></head><body><article><p>Eligible startups get Zendesk free for six months.</p></article></body></html>',
        );
  });

  const article = await new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  ).fetch(`${upstream.origin}/startups/`, AbortSignal.timeout(5000));

  assert.equal(article?.title, 'Zendesk for Startups');
  assert.deepEqual(requests, ['/startups/', '/business/startups/']);
});

test('a page whose browser request fails after a failed Markdown redirect fails with its own URL instead of giving the shell', async () => {
  await using upstream = await new HttpServer().start((request, response) => {
    if (
      request.url === '/' &&
      request.headers.accept?.startsWith('text/markdown')
    )
      response.writeHead(307, { location: '/index.md', vary: 'Accept' }).end();
    else if (request.url === '/index.md')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Linear</title></head><body><div id="root"></div><div id="loading"><div id="loading-content">Loading…</div></div></body></html>',
        );
    else response.writeHead(503).end();
  });

  await assert.rejects(
    new WebArticle(
      [new MarkdownExtraction(), new HTMLExtraction()],
      got.extend({ retry: { limit: 0 } }),
    ).fetch(`${upstream.origin}/`, AbortSignal.timeout(5000)),
    (error) => {
      assert.ok(error instanceof ArticleError);
      assert.equal(error.url, `${upstream.origin}/`);
      assert.ok(error.cause instanceof HTTPError);
      assert.equal(error.cause.response.statusCode, 503);
      return true;
    },
  );
});

test('Markdown files served as plain text retain short linked posts', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end('[A useful reference](/reference).');
  });
  const article = await new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  ).fetch(`${upstream.origin}/post.md?edition=2`, AbortSignal.timeout(5000));
  assert.equal(article?.markdown, '[A useful reference](/reference).');
  assert.match(article?.content ?? '', /useful reference/);
});

test('cancellation during an alternate download preserves the reason and does not fall back', async () => {
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  const reason = new Error('Stop the alternate download');
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/story') {
      response
        .writeHead(200, {
          'content-type': 'text/html',
          link: '</story.md>; rel="alternate"; type="text/markdown"',
        })
        .end('<article><p>A readable fallback.</p></article>');
    } else {
      response.writeHead(200, { 'content-type': 'text/markdown' });
      response.write('# Incomplete response\n');
      started.resolve();
    }
  });
  const fetching = new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  ).fetch(
    `${upstream.origin}/story`,
    AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  );
  const rejected = assert.rejects(fetching, (error) => error === reason);
  await started.promise;
  controller.abort(reason);
  await rejected;
});

test('executable front matter is rejected instead of evaluated', async () => {
  for (const language of ['js', 'javascript']) {
    await using upstream = await new HttpServer().start(
      (_request, response) => {
        response.setHeader('content-type', 'text/markdown');
        response.end(
          `---${language}\n({ title: 'Executed' })\n---\n# Visible article\n\nReadable prose.`,
        );
      },
    );
    await assert.rejects(
      new WebArticle([new MarkdownExtraction()], got).fetch(
        upstream.origin,
        AbortSignal.timeout(5000),
      ),
      (error) => {
        assert(error instanceof ArticleError);
        assert(error.cause instanceof TypeError);
        assert.match(error.cause.message, /Executable front matter/);
        return true;
      },
    );
  }
});
