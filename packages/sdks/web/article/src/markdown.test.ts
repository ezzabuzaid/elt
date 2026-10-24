import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';

import { HTMLExtraction, WebArticle } from './index.ts';

test('Markdown preserves article structure and excludes the same unsafe content and footer as HTML', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<html><head><title>Field observations</title></head><body><article>
      <h2>Measurements</h2><p>Our field observations compare <strong>three sensors</strong>. Read the <a href="/report">full report</a> for the calibration procedure.</p>
      <ul><li>Check each cable.</li><li>Repeat the reading.</li></ul>
      <blockquote><p>Keep the original measurements.</p></blockquote>
      <table><thead><tr><th>Site</th><th>Count</th></tr></thead><tbody><tr><td>A | B</td><td>3</td></tr></tbody></table>
      <pre><code>const reading = 3;\n\n  record(reading);</code></pre>
      <p><a href="javascript:alert(1)">Unsafe link</a><img src="/sensor.png" alt="Field sensor" onerror="alert(1)"></p>
      <footer><p>Subscribe for equipment offers.</p></footer>
      <script>globalThis.unwanted = true;</script>
    </article></body></html>`);
  });
  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.ok(article);
  assert.ok('markdown' in article);
  assert.equal(typeof article.markdown, 'string');
  assert.match(article.markdown, /## Measurements/);
  assert.ok(
    article.markdown.includes(`[full report](${upstream.origin}/report)`),
  );
  assert.match(article.markdown, /\*\*three sensors\*\*/);
  assert.match(article.markdown, /\* Check each cable\./);
  assert.match(article.markdown, /> Keep the original measurements\./);
  assert.match(article.markdown, /\| A \\\| B\s*\| 3\s*\|/);
  assert.match(
    article.markdown,
    /const reading = 3;\n *\n {6}record\(reading\);/,
  );
  assert.doesNotMatch(
    article.markdown,
    /equipment offers|javascript:|onerror|globalThis/,
  );
  const rendered = JSDOM.fragment(await marked.parse(article.markdown));
  assert.deepEqual(
    [...rendered.querySelectorAll('tr')].map((row) =>
      [...row.children].map((cell) => cell.textContent),
    ),
    [
      ['Site', 'Count'],
      ['A | B', '3'],
    ],
  );
  assert.equal(
    rendered.querySelector('pre code')?.textContent,
    'const reading = 3;\n\n  record(reading);\n',
  );
});

test('Markdown keeps escaped HTML as literal prose and leaves code unchanged', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      '<article><p>The literal example is &lt;img src=x onerror=alert(1)&gt; and the entity text is &amp;lt;tag&amp;gt;.</p><pre><code>if (x &lt; 2 &amp;&amp; y &gt; 1) {}</code></pre></article>',
    );
  });
  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert.ok(article);
  const rendered = JSDOM.fragment(await marked.parse(article.markdown));
  assert.equal(rendered.querySelector('img, script'), null);
  assert.equal(
    rendered.querySelector('p')?.textContent,
    'The literal example is <img src=x onerror=alert(1)> and the entity text is &lt;tag&gt;.',
  );
  assert.equal(
    rendered.querySelector('pre code')?.textContent,
    'if (x < 2 && y > 1) {}\n',
  );
});

test('Markdown keeps short linked posts, headerless tables and literal code fences', async () => {
  for (const body of [
    '<p>Try this <a href="https://tools.example/viewer">small viewer</a>.</p>',
    '<table><tr><td>North</td><td>7</td></tr><tr><td>South</td><td>9</td></tr></table>',
    '<p>The example prints a Markdown code fence.</p><pre><code>```\n  sample();\n```</code></pre>',
  ]) {
    await using upstream = await new HttpServer().start(
      (_request, response) => {
        response.setHeader('content-type', 'text/html');
        response.end(`<article>${body}</article>`);
      },
    );
    const article = await new WebArticle([new HTMLExtraction()], got).fetch(
      upstream.origin,
      AbortSignal.timeout(5000),
    );
    assert.ok(article);
    if (body.startsWith('<table>')) {
      assert.match(article.markdown, /\| North\s*\| 7\s*\|/);
      assert.match(article.markdown, /\| South\s*\| 9\s*\|/);
    } else if (body.includes('<pre>')) {
      assert.match(article.markdown, / {4}```\n {6}sample\(\);\n {4}```/);
      assert.equal(
        JSDOM.fragment(await marked.parse(article.markdown)).querySelector(
          'pre code',
        )?.textContent,
        '```\n  sample();\n```\n',
      );
    } else
      assert.equal(
        article.markdown,
        'Try this [small viewer](https://tools.example/viewer).',
      );
  }
});
