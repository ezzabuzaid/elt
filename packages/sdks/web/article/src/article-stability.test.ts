import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';
import { JSDOM } from 'jsdom';

import { WebArticle } from './index.ts';

test('article extraction preserves inline punctuation and preformatted spacing', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<html><body><article>
      <p>Our field study uses <a href="/method">HKDF</a>-SHA-256 to identify observations. The sensor ratio is 1.44 : 1, and the researchers record the exact values before reviewing the measurements together.</p>
      <p>They wrote: "<a href="/journal">Every observation matters.</a>" We reviewed the instruments and repeated the experiment to verify the findings.</p>
      <pre><code>if (ready) {\n    record("a  b");\n}</code></pre>
    </article></body></html>`);
  });
  const article = await new WebArticle(got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
  assert(article);
  const content = JSDOM.fragment(article.content);
  assert.match(content.textContent ?? '', /HKDF-SHA-256/);
  assert.match(content.textContent ?? '', /1\.44 : 1/);
  assert.match(content.textContent ?? '', /"Every observation matters\."/);
  assert.equal(
    content.querySelector('pre')?.textContent,
    'if (ready) {\n    record("a  b");\n}',
  );
});

test('ignored comments and insignificant whitespace do not change extracted HTML', async () => {
  let spaces = 4;
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<html><body><article>
      <p>The researchers reviewed every sensor reading before publishing their field notes. They repeated the experiment across several garden beds and documented the limits of the measurements.</p>
      ${' <!-- removed tracking marker --> '.repeat(spaces)}<p>The independent review found that the observations remained useful through cold weather and interrupted network access. The team published the procedure so others could repeat the trial.</p>
    </article></body></html>`);
  });
  const reader = new WebArticle(got);
  const first = await reader.fetch(upstream.origin, AbortSignal.timeout(5000));
  spaces = 17;
  const second = await reader.fetch(upstream.origin, AbortSignal.timeout(5000));
  assert(first && second);
  assert.match(first.textContent, /The independent review found/);
  assert.equal(second.content, first.content);
  assert.equal(second.textContent, first.textContent);
});
