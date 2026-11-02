import { join } from 'node:path';

import {
  Connection,
  Copy,
  CopyProgress,
  Pipeline,
  passChannels,
} from '@workspace/elt';
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

import activity from './activity.ts';
import { articlesPath } from './db.ts';
import directory from './directory.ts';
import settings from './settings.ts';

export const connector = 'web';

// Every site is one partition of a single WebSource, so one connection is the
// articles table's only writer.
const destination = new SQLiteDestination({ path: articlesPath });
// Passes run only inside the 'sync' flight, so no other process runs one: a
// pass left running belongs to a server that stopped, and is recorded as failed.
const history = new SQLiteSyncHistory({ soleWriter: true });
const checkpoints = new SQLiteCheckpointStore({
  path: join(directory, 'checkpoints.sqlite'),
});

// The page shows each copy of the web connection's pass while it runs.
passChannels.progress.subscribe((message) => {
  if (
    message instanceof CopyProgress &&
    message.connection.name === connector
  ) {
    activity.publish({
      kind: 'syncing',
      progress: {
        status: message.status,
        emitted: message.emitted,
        committed: message.committed,
      },
    });
  }
});

// Built on each Sync or Clear from the settings as they are then, because a
// WebSource's inputs cannot change after construction.
export default async function pipeline() {
  const { inputs, include } = await settings.read();
  // No saved pattern means every page.
  const [first, ...rest] = include.map((pattern) => new URLPattern(pattern));
  const source = new WebSource({
    streams: [
      {
        stream: new WebStream({
          name: 'articles',
          primaryKey: ['articleUrl'],
          readers: [
            new ListingReader(),
            new ArchiveReader(),
            new PaginationReader(),
            new LinkReader({ maxDepth: 3, maxPages: 100 }),
          ],
          include: first === undefined ? undefined : [first, ...rest],
          extractor: new ArticleExtractor(),
        }),
        inputs,
      },
    ],
    cachePath: join(directory, 'web-http.sqlite'),
    userAgent: 'elt-web-playground/0.1 (+https://github.com/ezzabuzaid/elt)',
  });
  return new Pipeline({
    history,
    connections: [
      new Connection({
        name: connector,
        source,
        destination,
        checkpoints,
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
}
