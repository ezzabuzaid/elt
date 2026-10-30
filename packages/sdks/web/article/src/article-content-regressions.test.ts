import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import {
  ArchiveReader,
  ListingReader,
  PaginationReader,
  WebCrawler,
} from '@workspace/sdk-web-crawler';

import { HTMLExtraction, MarkdownExtraction, WebArticle } from './index.ts';

test('a page whose stylesheet jsdom cannot parse writes nothing to the console', async (t) => {
  // A stray closing brace, as minified stylesheets on startup program pages
  // have; jsdom reports it as "Could not parse CSS stylesheet".
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url !== '/startups') return response.writeHead(404).end();
    response.end(`<html><head><title>Startups</title><style>.a{color:red}}</style></head><body>
<main><h1>Startups</h1><p>Get up to $100,000 in credits for your first year, with support from our team and partners.</p>
<p>Apply with your company details, and we answer within two weeks with the credits and the next steps.</p></main></body></html>`);
  });
  const errors = t.mock.method(console, 'error', () => {});

  const article = await new WebArticle(
    [new MarkdownExtraction(), new HTMLExtraction()],
    got,
  ).fetch(`${upstream.origin}/startups`, AbortSignal.timeout(5000));

  assert.match(article?.textContent ?? '', /\$100,000 in credits/);
  assert.deepEqual(
    errors.mock.calls.map(({ arguments: [message] }) => message),
    [],
  );
});

test('a page with an apostrophe inside a single-quoted attribute keeps its article', async () => {
  // Trimmed from circleci.com/startup-program/ on 2026-10-30: the FAQ's
  // analytics attribute is single-quoted and holds "What's", which ends the
  // attribute early. Browsers recover from such markup (HTML Standard §13.2).
  await using upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url !== '/startup-program/')
      return response.writeHead(404).end();
    response.end(`<html><head><title>CircleCI for Startups - CircleCI</title></head><body>
<main><h1>Up to $20,000 of free compute credits for eligible startups</h1>
<p>With this offer, you receive significantly more compute credits than the standard Performance Plan and everything that it entails, free Starter Support (valued at $249 per month) at no cost during the program.</p>
<p>If your usage exceeds the compute credit pool provided before the promotion period ends, we’ll work with you on a smooth transition to a paid plan. Our goal is zero pipeline disruption.</p>
<details class="group"><summary data-analytics-action="click-outer-cta" data-analytics-properties='{ "section": ["faq"], "position": 5, "link_type": "details", "cta_text": "What's included in the onboarding support?" }'><div>What's included in the onboarding support?</div></summary>
<div data-js-id="track-body-links"><p>Our team is available to help with brand new setup, pipeline architecture, configuration, and migration from any existing CI/CD tool (Jenkins, GitHub Actions, GitLab CI, Travis CI, etc.).</p></div></details>
</main></body></html>`);
  });

  const article = await new WebArticle([new HTMLExtraction()], got).fetch(
    `${upstream.origin}/startup-program/`,
    AbortSignal.timeout(5000),
  );

  assert.match(
    article?.textContent ?? '',
    /Our goal is zero pipeline disruption/,
  );
  assert.match(
    article?.textContent ?? '',
    /migration from any existing CI\/CD tool/,
  );
});

test('a discovered article retains its introductory summary before the main body', async () => {
  // Mirrors the separate front matter and body in the captured Fowler articles.
  // Original fixture prose keeps this independent of the live publisher.
  const upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    switch (request.url) {
      case '/':
        response.end(
          '<link rel="alternate" type="application/rss+xml" href="/feed.xml">',
        );
        break;
      case '/feed.xml':
        response.setHeader('content-type', 'application/rss+xml');
        response.end(
          '<rss><channel><item><link>/study</link></item></channel></rss>',
        );
        break;
      case '/study':
        response.end(`<html><head><title>Engineering garden sensors</title></head><body>
          <nav><a href="/">Home</a></nav>
          <main><h1>Engineering garden sensors</h1>
            <section class="frontMatter">
              <p class="abstract"><i>Battery-powered sensors need different engineering defaults. This study explains how a team combined field experiments, energy measurements, and recovery drills to keep a remote garden monitoring system dependable through winter.</i></p>
              <p class="date">15 October 2026</p>
              <div class="front-grid">
                <div class="author-list"><address>Lina Haddad</address></div>
                <div class="contents"><h2>Contents</h2><ul><li><a href="#Experiments">Field experiments</a></li></ul></div>
              </div>
            </section>
            <div class="paperBody deep"><section id="Experiments"><h2>Field experiments</h2>
              <p>We placed sensors in three garden beds and recorded the soil temperature every hour. The first week exposed a surprising problem: the devices consumed most of their energy reconnecting after brief interruptions, rather than taking measurements. The team reviewed the logs and designed a repeatable experiment to measure that overhead.</p>
              <p>Each device was then tested in a chamber that reproduced cold nights and warm afternoons. We compared fresh batteries with partially discharged cells, repeated every measurement, and recorded failures alongside successful runs. These observations helped the engineers distinguish a software regression from a physical limitation.</p>
              <p>The next experiment deliberately interrupted network access during a measurement. Devices retained the readings locally, waited before reconnecting, and sent the pending records once the connection recovered. We compared the recovered data with a separate reference recorder to verify that no observations had silently disappeared.</p>
              <p>The field trial continued for six weeks, including rain, frost, and several days without network access. Engineers inspected the devices each morning and compared the reported readings with handwritten observations. The final report describes the design decisions, their limitations, and the measurements needed to repeat the trial.</p>
            </section></div>
          </main>
          <footer>Subscribe to the garden newsletter.</footer>
        </body></html>`);
        break;
      default:
        response.writeHead(404).end();
    }
  });

  try {
    const signal = AbortSignal.timeout(5000);
    const pages = (
      await Array.fromAsync(
        new WebCrawler(got, [
          new ListingReader(),
          new ArchiveReader(),
          new PaginationReader(),
        ]).crawl([upstream.origin], null, { signal }),
      )
    )
      // Progress entries only mark documents the crawl read for its readers; a crawl with no memento defers nothing.
      .flatMap((entry) =>
        'progress' in entry || 'deferred' in entry ? [] : [entry],
      );
    assert.equal(pages.length, 1);
    const page = pages[0];
    assert.ok(page);
    const article = await new WebArticle([new HTMLExtraction()], got).fetch(
      page.url,
      signal,
    );

    assert.ok(article);
    assert.match(article.textContent, /We placed sensors in three garden beds/);
    assert.match(
      article.textContent,
      /Battery-powered sensors need different engineering defaults\./,
      'The introductory summary is part of the article, even outside its main body container.',
    );
  } finally {
    await upstream[Symbol.asyncDispose]();
  }
});

test('a feed article retains a figure caption containing a descriptive link', async () => {
  // Mirrors the linked figure caption in the captured slide-template article.
  // Trafilatura 2.3.1 retains this prose in the same synthetic document.
  const upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    switch (request.url) {
      case '/feed.xml':
        response.setHeader('content-type', 'application/rss+xml');
        response.end(
          '<rss><channel><item><link>/study</link></item></channel></rss>',
        );
        break;
      case '/study':
        response.end(`<html><head><title>Engineering garden sensors</title></head><body>
          <nav><a href="/">Home</a></nav>
          <main><h1>Engineering garden sensors</h1>
            <div class="paperBody deep"><section id="Experiments"><h2>Field experiments</h2>
              <p>We placed sensors in three garden beds and recorded the soil temperature every hour. The first week exposed a surprising problem: the devices consumed most of their energy reconnecting after brief interruptions, rather than taking measurements. The team reviewed the logs and designed a repeatable experiment to measure that overhead.</p>
              <p>Each device was then tested in a chamber that reproduced cold nights and warm afternoons. We compared fresh batteries with partially discharged cells, repeated every measurement, and recorded failures alongside successful runs. These observations helped the engineers distinguish a software regression from a physical limitation.</p>
              <div class="figure"><img src="/diagram.png">
                <p class="photoCaption">Figure 6: A <a href="/library">reusable diagram library for our field study</a> that uses the garden journal palette.</p>
              </div>
              <p>The next experiment deliberately interrupted network access during a measurement. Devices retained the readings locally, waited before reconnecting, and sent the pending records once the connection recovered. We compared the recovered data with a separate reference recorder to verify that no observations had silently disappeared.</p>
              <p>The field trial continued for six weeks, including rain, frost, and several days without network access. Engineers inspected the devices each morning and compared the reported readings with handwritten observations. The final report describes the design decisions, their limitations, and the measurements needed to repeat the trial.</p>
            </section></div>
          </main>
          <footer>Subscribe to the garden newsletter.</footer>
        </body></html>`);
        break;
      default:
        response.writeHead(404).end();
    }
  });

  try {
    const signal = AbortSignal.timeout(5000);
    const pages = (
      await Array.fromAsync(
        new WebCrawler(got, [
          new ListingReader(),
          new ArchiveReader(),
          new PaginationReader(),
        ]).crawl([`${upstream.origin}/feed.xml`], null, { signal }),
      )
    )
      // Progress entries only mark documents the crawl read for its readers; a crawl with no memento defers nothing.
      .flatMap((entry) =>
        'progress' in entry || 'deferred' in entry ? [] : [entry],
      );
    assert.equal(pages.length, 1);
    const page = pages[0];
    assert.ok(page);
    const article = await new WebArticle([new HTMLExtraction()], got).fetch(
      page.url,
      signal,
    );

    assert.ok(article);
    assert.match(article.textContent, /We placed sensors in three garden beds/);
    assert.match(
      article.textContent,
      /Figure 6: A reusable diagram library for our field study/,
      'A descriptive link does not make the surrounding figure caption navigation.',
    );
    assert.match(article.textContent, /that uses the garden journal palette\./);
    assert(article.content.includes(`href="${upstream.origin}/library"`));
  } finally {
    await upstream[Symbol.asyncDispose]();
  }
});

test('a feed article retains acknowledgments and an authorship disclosure after its main body', async () => {
  // Mirrors the appendix outside the main body in the captured Fowler articles.
  // Trafilatura 2.3.1 preserves both paragraphs in this synthetic document.
  const upstream = await new HttpServer().start((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    switch (request.url) {
      case '/feed.xml':
        response.setHeader('content-type', 'application/rss+xml');
        response.end(
          '<rss><channel><item><link>/study</link></item></channel></rss>',
        );
        break;
      case '/study':
        response.end(`<html><head><title>Engineering garden sensors</title></head><body>
          <nav><a href="/">Home</a></nav>
          <main><h1>Engineering garden sensors</h1>
            <div class="paperBody deep">
              <section id="Experiments"><h2>Field experiments</h2>
                <p>We placed sensors in three garden beds and recorded the soil temperature every hour. The first week exposed a surprising problem: the devices consumed most of their energy reconnecting after brief interruptions, rather than taking measurements. The team reviewed the logs and designed a repeatable experiment to measure that overhead.</p>
                <p>Each device was then tested in a chamber that reproduced cold nights and warm afternoons. We compared fresh batteries with partially discharged cells, repeated every measurement, and recorded failures alongside successful runs. These observations helped the engineers distinguish a software regression from a physical limitation.</p>
              </section>
              <section id="Recovery"><h2>Recovery</h2>
                <p>The next experiment deliberately interrupted network access during a measurement. Devices retained the readings locally, waited before reconnecting, and sent the pending records once the connection recovered. We compared the recovered data with a separate reference recorder to verify that no observations had silently disappeared.</p>
                <p>The field trial continued for six weeks, including rain, frost, and several days without network access. Engineers inspected the devices each morning and compared the reported readings with handwritten observations. The final report describes the design decisions, their limitations, and the measurements needed to repeat the trial.</p>
              </section>
              <section id="Validation"><h2>Validation</h2>
                <p>Our first validation compared readings from the same devices on successive mornings. We recorded the weather, inspected every cable, and noted when a battery had been replaced. The resulting log gave the reviewers enough context to explain differences without treating every change as evidence of a faulty sensor.</p>
                <p>The researchers also kept a separate notebook for unusual events in the garden. A damaged enclosure, a disconnected cable, or a moved sensor could all change the measurements. Linking those observations to the recorded times made it possible to distinguish equipment faults from changes in the soil itself.</p>
                <p>For the recovery trial, we removed the battery halfway through a write and then restarted the device. The previously completed readings remained available, and the interrupted sample was clearly marked as incomplete. Repeating this experiment helped us check the assumptions behind the storage design.</p>
                <p>Before publication, a second team followed the documented procedure using different devices. They reproduced the broad pattern, reported the remaining uncertainty, and identified measurements that needed a longer observation period. Their review established which claims were supported and which still required further experiments.</p>
              </section>
            </div>
            <div class="appendix"><section id="Acknowledgments"><h2>Acknowledgments</h2>
              <p>The field measurements were reviewed by Lina Haddad, who repeated the cold-weather trials and checked the recovery logs. Her observations corrected an early interpretation of the battery results and improved the final experimental procedure.</p>
              <p>An automated writing assistant helped edit grammar and organize the draft. The authors designed the experiments themselves, collected every measurement, and remain responsible for the findings and the interpretation presented in this report.</p>
            </section></div>
          </main>
          <footer>Subscribe to the garden newsletter.</footer>
        </body></html>`);
        break;
      default:
        response.writeHead(404).end();
    }
  });

  try {
    const signal = AbortSignal.timeout(5000);
    const pages = (
      await Array.fromAsync(
        new WebCrawler(got, [
          new ListingReader(),
          new ArchiveReader(),
          new PaginationReader(),
        ]).crawl([`${upstream.origin}/feed.xml`], null, { signal }),
      )
    )
      // Progress entries only mark documents the crawl read for its readers; a crawl with no memento defers nothing.
      .flatMap((entry) =>
        'progress' in entry || 'deferred' in entry ? [] : [entry],
      );
    assert.equal(pages.length, 1);
    const page = pages[0];
    assert.ok(page);
    const article = await new WebArticle([new HTMLExtraction()], got).fetch(
      page.url,
      signal,
    );

    assert.ok(article);
    assert.match(article.textContent, /Before publication, a second team/);
    assert.match(
      article.textContent,
      /The field measurements were reviewed by Lina Haddad/,
      'Article acknowledgments remain content when placed in a separate appendix.',
    );
    assert.match(
      article.textContent,
      /An automated writing assistant helped edit grammar and organize the draft\./,
    );
  } finally {
    await upstream[Symbol.asyncDispose]();
  }
});
