import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SingleFlight } from '@zukhruf/single-flight';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import {
  ArchiveReader,
  LinkReader,
  ListingReader,
  PaginationReader,
} from '@workspace/sdk-web-crawler';
import { ArticleExtractor } from '@workspace/source-web-pages/article-extractor';
import { WebSource } from '@workspace/source-web-pages/web-source';
import { WebStream } from '@workspace/source-web-pages/web-stream';

import { type Activity, settingsSchema } from './contract.ts';

export async function createServices() {
  const directory = join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'elt',
    'web',
  );
  const settingsPath = join(directory, 'sites.json');
  const articlesPath = join(directory, 'articles.sqlite');
  const checkpointsPath = join(directory, 'checkpoints.sqlite');
  const connector = 'web';
  const flightsDirectory = join(directory, 'flights');
  await mkdir(flightsDirectory, { recursive: true });

  // Every site is one partition of a single WebSource, so one connection is the
  // articles table's only writer.
  const destination = new SQLiteDestination({ path: articlesPath });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);

  const readSettings = async () =>
    existsSync(settingsPath)
      ? settingsSchema.parse(JSON.parse(await readFile(settingsPath, 'utf8')))
      : { inputs: [], include: [] };

  // EventEmitter keeps no last value, and a page that connects mid-sync needs it.
  const activity: { current: Activity } = { current: { kind: 'idle' } };
  const changes = new EventEmitter<{ change: [Activity] }>();
  const publish = (next: Activity) => {
    activity.current = next;
    changes.emit('change', next);
  };

  const pipeline = async () => {
    const { inputs, include } = await readSettings();
    const source = new WebSource({
      stream: new WebStream({
        name: 'articles',
        primaryKey: ['articleUrl'],
        readers: [
          new ListingReader(),
          new ArchiveReader(),
          new PaginationReader(),
          new LinkReader({ maxDepth: 3, maxPages: 100 }),
        ],
        include:
          include.length === 0
            ? undefined
            : include.map((pattern) => new URLPattern(pattern)),
        extractor: new ArticleExtractor(),
      }),
      inputs,
    });
    return new Pipeline({
      history,
      observer: {
        begin: () => ({
          progress: ({ status, emitted, committed }) =>
            publish({
              kind: 'syncing',
              progress: { status, emitted, committed },
            }),
          finish: () => undefined,
          fail: () => undefined,
        }),
      },
      connections: [
        new Connection({
          name: connector,
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({ path: checkpointsPath }),
          steps: (await source.discover()).streams.map(
            (stream) =>
              new Copy(stream, destination.table(stream.name), {
                id: 'web:articles',
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
              }),
          ),
        }),
      ],
    });
  };

  // A Sync or Clear while the same one runs joins it, in this process or another
  // that uses the folder. A Clear during a Sync is refused by elt's checkpoint
  // lock.
  const flights = new SingleFlight<void>({
    directory: flightsDirectory,
    codec: { encode: () => '', decode: () => undefined },
  });

  return {
    settingsPath,
    articlesPath,
    connector,
    readSettings,
    pipeline,
    activity,
    changes,
    publish,
    flights,
  };
}

export type Services = Awaited<ReturnType<typeof createServices>>;
