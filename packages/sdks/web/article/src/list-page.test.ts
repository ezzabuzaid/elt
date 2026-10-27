import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import got from 'got';

import {
  type Extraction,
  HTMLExtraction,
  MarkdownExtraction,
  WebArticle,
} from './index.ts';

async function extract(
  extraction: Extraction,
  contentType: string,
  body: string,
) {
  await using upstream = await new HttpServer().start((_request, response) => {
    response.writeHead(200, { 'content-type': contentType }).end(body);
  });
  return await new WebArticle([extraction], got).fetch(
    upstream.origin,
    AbortSignal.timeout(5000),
  );
}

// Three posts of a blog index, an article element each, with long excerpts.
const blogIndex = `
        <article><h2><a href="/kv-cache-exposure-remediation/">KV cache exposure remediation</a></h2><p>On October 24 we found that a configuration change exposed cached values to the wrong tenant for a short time. This post explains how we found the change, what data it touched and the steps we took to keep it from happening again.</p></article>
        <article><h2><a href="/workers-observability/">Observability for Workers</a></h2><p>Every Worker now gets traces and logs with no code change. We describe how the data flows from the edge to your dashboard, what it costs to keep, and how to export it to the tools your team already uses.</p></article>
        <article><h2><a href="https://blog.google/technology/ai/gemini-update/">A Gemini update for developers</a></h2><p>A guest post from a partner team about the models that power the new features, how we tested them with customers over the summer, and which limits we plan to remove before the end of the year.</p></article>`;

test('a page that lists pages of its own origin is still an article, labeled a list', async () => {
  for (const { name, html } of [
    {
      // As anthropic.com/news/features: cards inside one article element, og:type website, no JSON-LD.
      name: 'cards',
      html: `<html><head><title>Features</title><meta property="og:type" content="website"></head><body><main><article><h1>Features</h1><ul>
        <li><a href="/news/claude-code"><h3>Claude Code</h3><p>How the team builds the tool.</p><time>Oct 1, 2026</time></a></li>
        <li><a href="/news/memory"><h3>Memory</h3><p>Claude now remembers your projects.</p><time>Sep 9, 2026</time></a></li>
        <li><a href="/news/skills"><h3>Skills</h3><p>Folders of instructions for Claude.</p><time>Aug 2, 2026</time></a></li>
      </ul></article></main></body></html>`,
    },
    {
      // As the-decoder.com/tag/anthropic/: og:type article, but its JSON-LD declares a collection, and the excerpts are long.
      name: 'declared collection',
      html: `<html><head><title>Anthropic</title><meta property="og:type" content="article">
        <script type="application/ld+json">{"@context":"https://schema.org","@type":"CollectionPage","name":"Anthropic"}</script></head>
        <body><main><h1>Anthropic</h1>
        <p>Anthropic builds Claude. This page collects our reporting on the company, its models and its policy work.</p>
        <div><h2><a href="/first-report">First report</a></h2><p>A long excerpt of the first report that tells what happened in detail and why it matters to readers who follow the company.</p></div>
        <div><h2><a href="/second-report">Second report</a></h2><p>A long excerpt of the second report that tells what changed since the first report and what the company said about it.</p></div>
        </main></body></html>`,
    },
    {
      // As blog.cloudflare.com and deepmind.google/blog: an article element per post, long excerpts, no declared type.
      name: 'cards with long excerpts',
      html: `<html><head><title>The Cloudflare Blog</title><meta property="og:type" content="website"></head><body><main>
        ${blogIndex}
      </main></body></html>`,
    },
    {
      // As smashingmagazine.com/articles/ and css-tricks.com: the CMS declares an article, but the content is the same cards.
      name: 'cards on a page that declares an article',
      html: `<html><head><title>The Cloudflare Blog</title><meta property="og:type" content="article">
        <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Articles"}</script></head><body><main>
        ${blogIndex}
      </main></body></html>`,
    },
  ]) {
    const article = await extract(new HTMLExtraction(), 'text/html', html);

    assert.ok(article, name);
    assert.equal(article.list, true, name);
  }
});

test('an article that links many pages is not labeled a list', async () => {
  for (const { name, html } of [
    {
      // As this-week-in-rust.org: a roundup of links to other origins.
      name: 'roundup',
      html: `<html><head><title>This Week in Rust 674</title></head><body><article><h1>This Week in Rust 674</h1>
        <p>Hello and welcome to another issue of This Week in Rust.</p><ul>
        <li><a href="https://blog.rust-lang.org/2026/10/16/Rust-1.95.0/">Announcing Rust 1.95.0</a></li>
        <li><a href="https://example.org/async-drop">Async drop, one year on</a></li>
        <li><a href="https://example.net/borrow-checker">How the borrow checker sees loops</a></li>
        </ul></article></body></html>`,
    },
    {
      name: 'og:type article of own links',
      html: '<html><head><meta property="og:type" content="article"></head><body><article><p><a href="/first">First finding</a> <a href="/second">Second finding</a></p></article></body></html>',
    },
    {
      name: 'JSON-LD BlogPosting of own links',
      html: '<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"BlogPosting","headline":"Findings"}</script></head><body><article><p><a href="/first">First finding</a> <a href="/second">Second finding</a></p></article></body></html>',
    },
    {
      name: 'prose that names two pages of its origin',
      html: '<html><body><article><h1>Field notes</h1><p>We measured the soil again this week, as on <a href="/notes/first">our first visit</a> and <a href="/notes/second">the follow-up</a>, and the moisture stayed low across every plot we sampled.</p><p>The next visit adds the north beds and a second probe.</p></article></body></html>',
    },
    {
      // The HTML spec's own example: comments are article elements inside the post's article, and each links its author.
      name: 'a post with comments nested in it',
      html: `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"BlogPosting","headline":"Garden journal"}</script></head><body><main>
        <article><h1>Garden journal</h1>
          <p>We measure the soil each week and write down what we planted. The north beds dried faster than the south beds, so we moved a probe into the shade.</p>
          <section><h2>Comments</h2>
            <article><p><a href="https://lina.example/">Lina</a>: We saw the same in our beds this summer, and morning watering helped.</p></article>
            <article><p><a href="https://omar.example/">Omar</a>: Which probe do you use? Ours failed in wet ground after a month.</p></article>
          </section>
        </article>
      </main></body></html>`,
    },
    {
      // A live blog: each update is an article element whose only link is its own permalink on this page.
      name: 'a live blog of updates',
      html: `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"LiveBlogPosting","headline":"Storm updates"}</script></head><body><main>
        <article id="update-5"><h2><a href="#update-5">11:20</a></h2><p>Crews are moving sandbags to the streets near the old market before the next high tide, and the council asks drivers to stay away from the river road until the evening.</p></article>
        <article id="update-4"><h2><a href="#update-4">10:55</a></h2><p>The fire service has rescued two families from flooded houses in the east of the city, and both families are now safe in the school hall that the council opened as a shelter.</p></article>
        <article id="update-3"><h2><a href="#update-3">10:40</a></h2><p>The river has passed its flood mark in two places, and the council has closed the main bridge until the water goes down and engineers can check the supports.</p></article>
        <article id="update-2"><h2><a href="#update-2">10:05</a></h2><p>Power is back in the north of the city, but about two thousand homes in the south are still without it, and the power company expects to reconnect them by the afternoon.</p></article>
        <article id="update-1"><h2><a href="#update-1">09:30</a></h2><p>The storm reached the coast overnight with strong winds that brought down trees across the region, and the weather service expects the rain to stop by the evening.</p></article>
      </main></body></html>`,
    },
    {
      name: 'one linked sentence',
      html: '<html><body><div>See <a href="/results">the complete results from our garden study</a>.</div></body></html>',
    },
    {
      name: 'a table of links',
      html: '<html><body><article><p>Our releases this year:</p><table><tr><td><a href="/releases/1">Release one</a></td></tr><tr><td><a href="/releases/2">Release two</a></td></tr></table></article></body></html>',
    },
  ]) {
    const article = await extract(new HTMLExtraction(), 'text/html', html);

    assert.ok(article, name);
    assert.equal(article.list, false, name);
  }
});

test('a native Markdown page that lists pages of its own origin is labeled a list', async () => {
  const index = await extract(
    new MarkdownExtraction(),
    'text/markdown',
    '# Posts\n\n- [First post](/posts/first)\n- [Second post](/posts/second)\n- [Third post](/posts/third)\n',
  );
  const post = await extract(
    new MarkdownExtraction(),
    'text/markdown',
    '# A post\n\nSome prose that names [one page](/about) and [another page](/contact) of the site, and then says more about the garden study and what it found.\n',
  );

  assert.equal(index?.list, true);
  assert.equal(post?.list, false);
});
