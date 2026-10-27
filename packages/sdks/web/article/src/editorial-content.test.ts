import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import { HTMLExtraction, WebArticle } from './index.ts';

test('editorial asides retain explanations and contributor lists inside an article', async () => {
  // Local markup reproduces the captured editorial sidebars without relying on a publisher.
  const upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<html><head><title>Designing a field experiment</title></head><body>
      <main><article><h1>Designing a field experiment</h1>
        <p>Our garden experiment compares soil moisture across three beds. We record the weather, inspect the sensors, and repeat each measurement before drawing conclusions. This article describes the procedure and the people who checked the results.</p>
        <aside class="sidebar"><h2>A calibration exercise</h2>
          <p>Before taking measurements, place each sensor in the same sample. Differences between readings reveal calibration errors that would otherwise look like changes in the soil.</p>
          <ol><li>Record a reference reading before moving the sensor.</li><li>Repeat the measurement after cleaning the contacts.</li></ol>
        </aside>
        <p>The sensors stayed outside for six weeks. Every morning we compared their readings with handwritten observations and recorded damaged cables or unusual weather. These notes allowed the reviewers to separate equipment faults from real changes in the garden.</p>
        <aside class="post-aside--large"><h2>Meet the reviewers</h2><ul>
          <li>Lina Haddad, a field engineer who checked the calibration records.</li>
          <li>Omar Mansour, a researcher who repeated the cold weather trials.</li>
          <li>Nadia Saleh, a statistician who independently reviewed the measurements.</li>
        </ul></aside>
        <p>A second team followed the published procedure with different equipment. They reproduced the main findings and identified which observations needed a longer study. The final report includes both the successful measurements and the limitations discovered during this review.</p>
      </article></main>
      <aside><p>Subscribe to our weekly garden newsletter for exclusive offers.</p></aside>
    </body></html>`);
  });

  try {
    const article = await new WebArticle([new HTMLExtraction()], got).fetch(
      upstream.origin,
      AbortSignal.timeout(5000),
    );
    assert.ok(article);
    assert.match(
      article.textContent,
      /Before taking measurements, place each sensor in the same sample/,
    );
    assert.match(
      article.textContent,
      /Record a reference reading before moving the sensor/,
    );
    assert.match(article.textContent, /Lina Haddad, a field engineer/);
    assert.match(article.textContent, /Omar Mansour, a researcher/);
    assert.match(article.textContent, /Nadia Saleh, a statistician/);
    assert.doesNotMatch(article.textContent, /exclusive offers/);
  } finally {
    await upstream[Symbol.asyncDispose]();
  }
});

test('unmarked pages still exclude class-based navigation and advertising', async () => {
  const upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<html><head><title>Checking the field readings</title></head><body><div id="Box">
      <div id="Banner"><a href="/">Garden Journal home page</a></div>
      <div id="Sidebar"><ul><li><a href="/archive">Browse the archive</a></li><li><a href="/contact">Contact our publisher</a></li></ul>
        <div class="ad"><p>Buy premium equipment from our advertising partner.</p></div>
      </div>
      <div id="Main"><h1>Checking the field readings</h1><div>
        <p>The field team recorded readings from three garden beds throughout the winter. Each morning, they compared the instruments with a reference sensor and wrote down the weather conditions. This procedure helped them distinguish faulty equipment from actual changes in the soil.</p>
        <p>One sensor stopped reporting after a night of heavy rain. Inspection revealed a damaged connector, which the team replaced before repeating the calibration. The repaired sensor matched the reference instrument during the remaining weeks of the trial.</p>
        <p>The final report includes the original readings and the maintenance notes. A second team repeated the experiment with different instruments, confirmed the findings, and recorded the remaining uncertainty for future studies.</p>
      </div></div>
      <div id="Footer"><p>Copyright 2026 Garden Journal. All rights reserved.</p></div>
    </div></body></html>`);
  });
  try {
    const article = await new WebArticle([new HTMLExtraction()], got).fetch(
      upstream.origin,
      AbortSignal.timeout(5000),
    );
    assert.ok(article);
    assert.match(article.textContent, /The field team recorded readings/);
    assert.doesNotMatch(
      article.textContent,
      /Garden Journal home page|Browse the archive|Contact our publisher|advertising partner|All rights reserved/,
    );
  } finally {
    await upstream[Symbol.asyncDispose]();
  }
});

test('footer cleanup preserves author metadata without emitting promotional footer prose', async () => {
  const upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<html><head><title>Garden measurements</title></head><body><article>
      <h1>Garden measurements</h1>
      <p>We compared soil measurements across three garden beds and checked each sensor against a reference instrument before drawing conclusions.</p>
      <p>The repeated trials revealed a faulty connector. After its replacement, the readings matched throughout the remaining field study.</p>
      <footer><span rel="author">Lina Haddad</span><p>Subscribe for equipment offers.</p></footer>
    </article></body></html>`);
  });
  try {
    const article = await new WebArticle([new HTMLExtraction()], got).fetch(
      upstream.origin,
      AbortSignal.timeout(5000),
    );
    assert.ok(article);
    assert.equal(article.byline, 'Lina Haddad');
    assert.match(article.textContent, /We compared soil measurements/);
    assert.doesNotMatch(article.textContent, /Subscribe for equipment offers/);
  } finally {
    await upstream[Symbol.asyncDispose]();
  }
});

test('an incidental entry widget does not replace semantic article content', async () => {
  for (const container of [
    'article',
    'main',
    'div role="article"',
    'div role="main"',
  ]) {
    const tag = container.split(' ')[0];
    const upstream = await new HttpServer().start((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<html><head><title>Checking the garden measurements</title></head><body>
        <div class="entry"><p>A promotional entry about unrelated equipment offers.</p></div>
        <${container}><h1>Checking the garden measurements</h1>
          <p>Our team compared the sensor readings with a reference instrument every morning. We recorded the weather and checked each cable before making changes to the equipment.</p>
          <p>The repeated measurements revealed that one sensor needed calibration. After replacing its damaged connector, the readings matched the reference throughout the remaining field trial.</p>
        </${tag}>
      </body></html>`);
    });
    try {
      const article = await new WebArticle([new HTMLExtraction()], got).fetch(
        upstream.origin,
        AbortSignal.timeout(5000),
      );
      assert.ok(article);
      assert.match(
        article.textContent,
        /Our team compared the sensor readings/,
      );
      assert.match(article.textContent, /one sensor needed calibration/);
      assert.doesNotMatch(article.textContent, /unrelated equipment offers/);
    } finally {
      await upstream[Symbol.asyncDispose]();
    }
  }
});

test('a short linked post retains the outbound resource in its title row', async () => {
  // A classic WordPress theme puts the post's .entry inside its .post: still one post.
  for (const { open, close } of [
    { open: '<div class="entry">', close: '</div>' },
    { open: '<div class="post"><div class="entry">', close: '</div></div>' },
  ]) {
    const upstream = await new HttpServer().start((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<html><head><title>Tool: Soil Viewer</title></head><body>
        ${open}<div>
          <div><a href="/category/tools">Tool</a> <span><a href="https://tools.example.org/soil-viewer">Soil Viewer</a></span></div>
          <div><p>I built this tool to compare readings from the garden sensors.</p>
            <blockquote><p>Plot the measurements on a map and highlight sudden changes.</p></blockquote>
            <p>The viewer makes it easier to find disconnected cables before the next field visit.</p>
            <p>Each sensor appears beside its most recent reading. Select a point to see the measurements from the previous week, compare nearby sensors, and inspect the notes recorded during maintenance. The chart keeps missing observations visible instead of connecting them with a line, so a failed sensor cannot look like a successful measurement.</p>
          </div>
        </div>${close}
      </body></html>`);
    });
    try {
      const article = await new WebArticle([new HTMLExtraction()], got).fetch(
        upstream.origin,
        AbortSignal.timeout(5000),
      );
      assert.ok(article, open);
      assert.ok(
        article.content.includes(
          'href="https://tools.example.org/soil-viewer"',
        ),
        open,
      );
      assert.match(
        article.textContent,
        /Soil Viewer \[https:\/\/tools.example.org\/soil-viewer\]/,
        open,
      );
      assert.match(article.textContent, /Plot the measurements on a map/, open);
    } finally {
      await upstream[Symbol.asyncDispose]();
    }
  }
});

test('a short link post keeps its prose when a hidden link card and a members-only notice hold more words', async () => {
  // kottke.org's markup, trimmed: one sentence of prose, a link card that is
  // hidden from assistive technology, and a modal for non-members.
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<html><head><title>Lego is considering making this fan-created Daft Punk set into an official set.</title></head><body>
      <div class="big-hug"><div class="grid-container">
        <div class="grid-item"><nav><a href="/">Home</a> <a href="/archive">Archive</a></nav></div>
        <div class="grid-item"><div class="post">
          <div class="post-meta">posted <time datetime="2025-11-06T16:20:36Z">Nov 6 @ 11:20 AM</time> by <a href="http://www.kottke.org">Jason Kottke</a></div>
          <p>Lego is considering making <a href="https://ideas.lego.com/product-ideas/4248139c">this fan-created Daft Punk set</a> into an official set. YES PLEASE.</p>
          <div class="url-card">
            <a href="https://ideas.lego.com/product-ideas/4248139c" aria-hidden="true"><div class="url-card-image"><img src="/images/unfurls/thumb-47799.jpg" alt=""></div></a>
            <a href="https://ideas.lego.com/product-ideas/4248139c" aria-hidden="true"><div class="url-card-content"><div class="url-card-title">Daft Punk Concert<span class="url-card-url"> · ideas.lego.com</span></div>
              <div class="url-card-description">4 years ago, this set won the Grand Prize in the global LEGO competition Music To Our Ears!, though it wasn’t selected to become an official set. But now we’re feeling inspired to Get Lucky and try One More Time after seeing the Daft Punk making their LEGO debut in the upcoming film Piece By Piece, robot-rocking their amazing helmets alongside Pharrell Williams.</div></div></a>
          </div>
        </div></div>
      </div></div>
      <div class="modal"><div class="modal-content"><p>In order to comment or fave, you need to be a kottke.org member. <a href="/members">Check out your membership options</a>.</p>
        <p class="smaller">Note: If you are a member and tried to log in, it didn't work, and now you're stuck in a neverending login loop of death, try disabling any ad blockers or extensions. Or try logging out and then back in. If that doesn't work, email me and we'll sort it out together.</p></div></div>
    </body></html>`);
  });

  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );

  assert.ok(article);
  assert.match(
    article.textContent,
    /Lego is considering making this fan-created Daft Punk set/,
  );
  assert.doesNotMatch(article.textContent, /neverending login loop/);
});

test('a page of several posts is not taken for its first post', async () => {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<html><head><title>Field notes</title></head><body>
      <div class="h-entry"><h2><a href="/notes/first">First visit</a></h2><p>We measured the soil in every plot of the garden and found the moisture lower than in the spring.</p></div>
      <div class="h-entry"><h2><a href="/notes/second">Second visit</a></h2><p>The north beds dried faster than the south beds, so we moved the second probe to the shade.</p></div>
    </body></html>`);
  });

  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );

  assert.ok(article);
  assert.match(article.textContent, /moisture lower than in the spring/);
  assert.match(article.textContent, /moved the second probe to the shade/);
});

test('a short post excludes surrounding sponsorship, recommendations and site footer', async () => {
  for (const postClass of ['entry', 'h-entry', 'hentry']) {
    const upstream = await new HttpServer().start((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<html><head><title>A useful field recording</title></head><body>
        <div><strong>Supported by:</strong> Garden Instruments makes reliable sensors.
          <a href="/offer" rel="sponsored noopener">Request a demonstration</a></div>
        <div class="${postClass}"><p>This <a href="/recording">field recording</a> captures an unusual bird call. The original measurements are available in the linked research notebook.</p>
          <footer><p>Subscribe to our weekly newsletter for exclusive equipment offers.</p></footer>
        </div>
        <div><h2>Recent articles</h2><ul>
          <li><a href="/previous">Our previous report on growing vegetables</a> - October 20</li>
          <li><a href="/older">An introduction to maintaining soil sensors</a> - October 12</li>
        </ul></div>
        <footer><p>Subscribe to our weekly newsletter for exclusive equipment offers.</p></footer>
      </body></html>`);
    });
    try {
      const article = await new WebArticle([new HTMLExtraction()], got).fetch(
        upstream.origin,
        AbortSignal.timeout(5000),
      );
      assert.ok(article);
      assert.match(article.textContent, /captures an unusual bird call/);
      assert.ok(
        article.content.includes(`href="${upstream.origin}/recording"`),
      );
      assert.doesNotMatch(
        article.textContent,
        /Supported by|Garden Instruments|Request a demonstration|Recent articles|previous report|maintaining soil|exclusive equipment offers/,
      );
    } finally {
      await upstream[Symbol.asyncDispose]();
    }
  }
});
