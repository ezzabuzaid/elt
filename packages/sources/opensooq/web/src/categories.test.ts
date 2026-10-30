import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import { Sqlite } from '@zukhruf/testing/sqlite';

import { Connection, Copy, Pipeline, PipelineError } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import { WebSource } from '@workspace/source-web-pages/web-source';

import { categories } from './categories.ts';

// A trimmed copy of the Jordan home page on 2026-10-30: a visible menu that
// links the top-level categories, and the hidden megaMenuRaw list that links
// each top-level category before the categories under it.
const menu = `<div class="hidden" aria-hidden="true" id="megaMenuRaw"><a href="/en/cars">Autos</a><a href="/en/cars/cars-for-sale">Cars For Sale</a><a href="/en/cars/motorcycles-and-motor-vehicles">Motorcycles &amp; Accessories</a><a href="/en/cars/motorcycles">Motorcycles</a><a href="/en/property">Property</a><a href="/en/property/apartments-for-rent">Apartments for Rent</a></div>`;

async function homePage(body: string) {
  const requests: string[] = [];
  const upstream = await new HttpServer().start((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push(url.pathname);
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/en')
      response.end(
        `<html><body><nav><a href="/en/cars">Autos</a><a href="/en/property">Property</a></nav>${body}<main><a href="/en/search/287909010">A listing</a></main></body></html>`,
      );
    else if (url.pathname === '/robots.txt') response.writeHead(404).end();
    else response.end('<html><body><p>A category.</p></body></html>');
  });
  return Object.assign(upstream, { requests });
}

async function pipeline(source: WebSource, path: string, checkpoints: string) {
  const destination = new SQLiteDestination({ path });
  return new Pipeline({
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'opensooq',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({ path: checkpoints }),
        steps: (await source.discover()).streams.map(
          (stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: `opensooq:${stream.name}`,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  });
}

test('a home page without its hidden category menu fails, and stores no categories', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  await using upstream = await homePage('<div id="menu"></div>');
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [{ stream: categories, inputs: [`${upstream.origin}/en`] }],
    }),
    database.path,
    checkpoints.path,
  );

  await assert.rejects(ingestion.run(), (error) => {
    assert(error instanceof PipelineError);
    assert.match(String(error.results[0]?.failures[0]?.error), /megaMenuRaw/);
    return true;
  });

  assert.equal(
    database.connection
      .prepare('SELECT count(*) AS count FROM opensooq_categories')
      .get()?.count,
    0,
  );
});

test('the categories are read from the home page alone, and no category page is requested', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  await using upstream = await homePage(menu);
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [{ stream: categories, inputs: [`${upstream.origin}/en`] }],
    }),
    database.path,
    checkpoints.path,
  );

  await ingestion.run();

  assert.deepEqual(
    upstream.requests.filter(
      (path) => path !== '/en' && path !== '/robots.txt',
    ),
    [],
  );
});

test('each category of the hidden menu is stored with its absolute URL, its name and the top-level category it is under', async () => {
  await using cache = await mkdtempDisposable(join(tmpdir(), 'web-cache-'));
  await using upstream = await homePage(menu);
  await using database = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const ingestion = await pipeline(
    new WebSource({
      cachePath: join(cache.path, 'web-http.sqlite'),
      userAgent: 'elt-test/1.0',
      streams: [{ stream: categories, inputs: [`${upstream.origin}/en`] }],
    }),
    database.path,
    checkpoints.path,
  );

  await ingestion.run();

  const { origin } = upstream;
  assert.deepEqual(
    database.connection
      .prepare(
        'SELECT url, name, "group" FROM opensooq_categories ORDER BY url',
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { url: `${origin}/en/cars`, name: 'Autos', group: null },
      {
        url: `${origin}/en/cars/cars-for-sale`,
        name: 'Cars For Sale',
        group: 'Autos',
      },
      {
        url: `${origin}/en/cars/motorcycles`,
        name: 'Motorcycles',
        group: 'Autos',
      },
      {
        url: `${origin}/en/cars/motorcycles-and-motor-vehicles`,
        name: 'Motorcycles & Accessories',
        group: 'Autos',
      },
      { url: `${origin}/en/property`, name: 'Property', group: null },
      {
        url: `${origin}/en/property/apartments-for-rent`,
        name: 'Apartments for Rent',
        group: 'Property',
      },
    ],
  );
});
