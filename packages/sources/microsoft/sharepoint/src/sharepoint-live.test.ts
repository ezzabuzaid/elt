import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { open } from '@zukhruf/sqlite-open';

import {
  Connection,
  Copy,
  DocumentText,
  LocalFiles,
  Pipeline,
} from '@eltjs/elt';
import {
  ComputedDataset,
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@eltjs/elt-sqlite';
import { OfficeDocumentParser } from '@eltjs/parser-office/office-document-parser';
import { SharePointClient } from '@eltjs/sdk-microsoft-sharepoint';

import { SharePointSource } from './sharepoint-source.ts';

// A real site the app has a read grant on, named by whoever runs the test:
// no tenant or site of a real organization is committed.
const {
  SHAREPOINT_TENANT_ID: tenantId = '',
  SHAREPOINT_CLIENT_ID: clientId = '',
  SHAREPOINT_CLIENT_SECRET: clientSecret = '',
  SHAREPOINT_LIVE_SITE_URL: siteUrl = '',
} = process.env;

// The Office parser, narrowed to workbooks: the pass downloads the few
// workbooks of the site, not its 2 GB of documents.
class WorkbookParser extends OfficeDocumentParser {
  override accepts(fileName: string): boolean {
    return fileName.toLowerCase().endsWith('.xlsx');
  }
}

test(
  'a pass over a granted site loads every stream, at least as many rows as the probe of 2026-11-17 counted, and a second pass writes nothing',
  {
    skip:
      tenantId === '' ||
      clientId === '' ||
      clientSecret === '' ||
      siteUrl === ''
        ? 'needs SHAREPOINT_TENANT_ID, SHAREPOINT_CLIENT_ID, SHAREPOINT_CLIENT_SECRET and SHAREPOINT_LIVE_SITE_URL'
        : false,
  },
  async () => {
    await using dir = await new TemporaryFiles().directory('sharepoint-live-');
    const source = new SharePointSource({
      client: new SharePointClient({
        tenantId,
        clientId,
        clientSecret,
        clock: globalThis,
      }),
      sites: [siteUrl],
    });
    const destination = new SQLiteDestination({
      path: join(dir.path, 'warehouse.sqlite'),
    });
    const files = new LocalFiles({ directory: join(dir.path, 'files') });
    const parser = new WorkbookParser();
    const { streams } = await source.discover();
    const driveItems = destination.table('driveItems', (c) => [
      ...SQLiteColumns.fromSchema(source.driveItems.jsonSchema),
      c
        .text('documentRef')
        .from(source.driveItems.file.accepting(parser).store(files)),
    ]);
    const pipeline = new Pipeline({
      clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'sharepoint',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({
            path: join(dir.path, 'checkpoints.sqlite'),
          }),
          steps: streams.map(
            (stream) =>
              new Copy(
                stream,
                stream === source.driveItems
                  ? driveItems
                  : destination.table(stream.name),
                {
                  id: `${source.identity}/${stream.name}`,
                  syncMode: 'incremental',
                  destinationSyncMode: 'append_dedup',
                },
              ),
          ),
        }),
      ],
      derived: [
        new ComputedDataset({
          into: destination,
          name: 'document_text',
          description: 'The text of each stored workbook.',
          from: [driveItems],
          compute: new DocumentText({
            parser: () => parser,
            files: files.directory,
            column: 'documentRef',
          }),
        }),
      ],
    });

    await pipeline.run();
    const second = await pipeline.run();

    using db = open(destination.path, { readOnly: true });
    const count = (sql: string) =>
      Number(Object.values({ ...db.prepare(sql).get() })[0]);
    assert.equal(count('SELECT count(*) FROM sites'), 1);
    assert.ok(count('SELECT count(*) FROM drives') >= 6);
    assert.ok(count('SELECT count(*) FROM lists') >= 10);
    assert.ok(count('SELECT count(*) FROM listColumns') > 0);
    assert.ok(
      count('SELECT count(*) FROM driveItems WHERE isFolder = 0') >= 5000,
    );
    // 314 folders on 2026-11-17; the delta gave them 682 times, since it
    // repeats a folder when its children change.
    assert.ok(
      count('SELECT count(*) FROM driveItems WHERE isFolder = 1') >= 300,
    );
    // The root folder of a library has no eTag; no other item lacks one.
    assert.equal(
      count('SELECT count(*) FROM driveItems WHERE eTag IS NULL'),
      0,
    );
    assert.equal(
      count(
        "SELECT count(*) FROM driveItems WHERE lastModifiedDateTime NOT LIKE '____-__-__T__:__:__.___Z'",
      ),
      0,
    );
    assert.ok(count('SELECT count(*) FROM listItems') >= 6000);
    assert.equal(
      count('SELECT count(*) FROM listItems WHERE json_valid(fields) = 0'),
      0,
    );
    assert.ok(count('SELECT count(*) FROM pages') >= 4);
    assert.ok(
      count(
        "SELECT count(*) FROM document_text WHERE status = 'computed' AND content <> ''",
      ) > 0,
    );
    assert.equal(
      count(
        "SELECT count(*) FROM driveItems WHERE documentRef IS NOT NULL AND lower(name) NOT LIKE '%.xlsx'",
      ),
      0,
    );
    assert.deepEqual(
      second
        .filter(({ count, deleted }) => count + deleted > 0)
        .map(({ copy, count, deleted }) => ({
          stream: copy.from.name,
          count,
          deleted,
        })),
      [],
    );
  },
);
