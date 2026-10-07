import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  AppIntents,
  DisplayIsBacklit,
  KnowledgeSchemaError,
  KnowledgeStore,
  KnowledgeUnavailableError,
} from './index.ts';

test('a knowledgeC that is missing fails with KnowledgeUnavailableError naming its path', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'knowledge-'));
  const path = join(scratch.path, 'knowledgeC.db');

  assert.throws(
    () => new KnowledgeStore(path).open(),
    (error: unknown) =>
      error instanceof KnowledgeUnavailableError &&
      error.message.includes(`${path} cannot be read`),
  );
});

test('a layout without a column fails only the reads that need it, and the others still read from the same snapshot', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'knowledge-'));
  const path = join(scratch.path, 'knowledgeC.db');
  {
    // knowledgeC without ZOBJECT.ZVALUEINTEGER, which only the backlight
    // stream reads.
    using knowledge = new DatabaseSync(path);
    knowledge.exec(`
      CREATE TABLE ZOBJECT (Z_PK INTEGER PRIMARY KEY, ZUUID VARCHAR, ZSTREAMNAME VARCHAR, ZSTARTDATE TIMESTAMP, ZENDDATE TIMESTAMP, ZCREATIONDATE TIMESTAMP, ZSECONDSFROMGMT INTEGER, ZVALUESTRING VARCHAR, ZSTRUCTUREDMETADATA INTEGER, ZSOURCE INTEGER);
      CREATE TABLE ZSTRUCTUREDMETADATA (Z_PK INTEGER PRIMARY KEY, Z_DKINTENTMETADATAKEY__DIRECTION INTEGER, Z_DKINTENTMETADATAKEY__DONATEDBYSIRI INTEGER, Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS INTEGER, Z_DKINTENTMETADATAKEY__INTENTTYPE INTEGER, Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER VARCHAR, Z_DKINTENTMETADATAKEY__INTENTCLASS VARCHAR, Z_DKINTENTMETADATAKEY__INTENTVERB VARCHAR, Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER VARCHAR, Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS VARCHAR, Z_DKINTENTMETADATAKEY__SERIALIZEDINTERACTION BLOB);
      CREATE TABLE ZSOURCE (Z_PK INTEGER PRIMARY KEY, ZBUNDLEID VARCHAR, ZDEVICEID VARCHAR, ZGROUPID VARCHAR, ZITEMID VARCHAR);
      INSERT INTO ZOBJECT (ZUUID, ZSTREAMNAME, ZSTARTDATE, ZENDDATE, ZCREATIONDATE, ZSECONDSFROMGMT, ZVALUESTRING) VALUES ('INTENT-1', '/app/intents', 0, 0, 0, 10800, 'Messages');
    `);
  }
  using snapshot = new KnowledgeStore(path).open();

  const backlight = () => snapshot.events(new DisplayIsBacklit());
  const intents = snapshot.events(new AppIntents());

  assert.throws(
    backlight,
    (error: unknown) =>
      error instanceof KnowledgeSchemaError &&
      /missing ZOBJECT\.ZVALUEINTEGER\)/.test(error.message),
  );
  assert.deepEqual(
    intents.map(({ id, category, startedAt }) => ({
      id,
      category,
      startedAt,
    })),
    [
      {
        id: 'INTENT-1',
        category: 'Messages',
        startedAt: new Date('2001-01-01T00:00:00.000Z'),
      },
    ],
  );
});
