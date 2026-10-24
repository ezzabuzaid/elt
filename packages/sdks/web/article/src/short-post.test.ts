import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import { HTMLExtraction, WebArticle } from './index.ts';

test('short linked prose survives beside a longer subscription section', async () => {
  // Reproduces the nested prose, link density and competing sidebar observed
  // in a live short post. A local page keeps the public HTTP test deterministic.
  const upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<html><head><title>A field recording</title></head><body>
      <div id="primary"><div class="entry">
        <p>22nd October 2026 - Link Blog</p>
        <div>
          <p><strong><a href="/recording">AUTUMN - FIELD RECORDING (Official Video)</a></strong>
            (<a href="/discussion">via</a>) This is an unusual discovery... at
            <a href="/recording?t=44">00:44</a> in this new recording by the
            independent research team <a href="/team">Garden Observers</a>:</p>
          <p><video src="/recording.mp4" controls></video></p>
          <p>The field measurements were recorded by Lina Haddad of
            <a href="/laboratory">The Open Garden Laboratory</a>.</p>
        </div>
        <div class="entryFooter">Posted <a href="/archive">22nd October 2026</a></div>
      </div></div>
      <div id="secondary"><div class="metabox">
        <p>This is a link post by a field researcher, posted in the autumn archive.</p>
        <a href="/tags">plants gardens observations</a>
        <section><h3>Monthly briefing</h3>
          <p>Sponsor our work for ten dollars each month and get a curated email
            digest of the most important developments in garden research.</p>
          <p>Pay us to send you less!</p><a href="/subscribe">Sponsor and subscribe</a>
        </section>
      </div></div>
    </body></html>`);
  });

  try {
    const article = await new WebArticle([new HTMLExtraction()], got).fetch(
      upstream.origin,
      AbortSignal.timeout(5000),
    );

    assert.ok(article);
    assert.match(article.textContent, /This is an unusual discovery/);
    assert.match(
      article.textContent,
      /field measurements were recorded by Lina Haddad/,
    );
    assert.doesNotMatch(
      article.textContent,
      /monthly briefing|sponsor our work/i,
    );
  } finally {
    await upstream[Symbol.asyncDispose]();
  }
});
