import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  Connection,
  Copy,
  copyStatus,
  LocalFiles,
  Pipeline,
  PipelineError,
  type Stream,
} from 'elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
} from 'elt-sqlite';
import { apps } from './apps.ts';
import type { AppConfiguration, SyncResult } from './settings.ts';

const attachmentRef = {
  type: ['string', 'null'],
  description: 'Managed local copy when bytes are available',
};

// Imports one app into <directory>/<app>: data.sqlite for records and the
// _apple_catalog table, checkpoints.sqlite, and files/ for attachment copies.
export async function importApp(
  directory: string,
  { app, scope, includeAttachments }: AppConfiguration,
  lastSucceededAt: string | undefined,
): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const failure = (error: unknown) =>
    `${error instanceof Error ? error.message : String(error)} ${apps[app].permissions}`;
  try {
    const source = apps[app].source(scope);
    const catalog = await source.discover();
    const omitted = new Set(
      Object.keys(scope).length > 0 ? (apps[app].unscoped ?? []) : [],
    );
    const streams = catalog.streams.filter(
      (stream) => !omitted.has(stream.name),
    );
    const withFiles = (stream: Stream) =>
      includeAttachments && stream.supportsFileTransfer === true;
    const appDirectory = join(directory, app);
    mkdirSync(appDirectory, { recursive: true, mode: 0o700 });
    const destination = new SQLiteDestination({
      path: join(appDirectory, 'data.sqlite'),
    });
    const files = new LocalFiles({ directory: join(appDirectory, 'files') });
    const pipeline = new Pipeline({
      connections: [
        new Connection({
          name: app,
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({
            path: join(appDirectory, 'checkpoints.sqlite'),
          }),
          steps: streams.map(
            (stream) =>
              new Copy(
                stream,
                withFiles(stream)
                  ? destination.table(stream.name, (columns) => [
                      ...SQLiteColumns.fromSchema(stream.jsonSchema),
                      columns
                        .text('attachmentRef')
                        .from(stream.file.store(files)),
                    ])
                  : destination.table(stream.name),
                {
                  id: `${app}:${stream.name}`,
                  syncMode: 'incremental',
                  destinationSyncMode: 'append_dedup',
                },
              ),
          ),
        }),
      ],
    });
    {
      using data = new DatabaseSync(destination.path);
      data.exec(
        'CREATE TABLE IF NOT EXISTS _apple_catalog (name TEXT PRIMARY KEY, schema_json TEXT NOT NULL, coverage_json TEXT NOT NULL);',
      );
      const publish = data.prepare(
        'INSERT INTO _apple_catalog VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET schema_json=excluded.schema_json, coverage_json=excluded.coverage_json',
      );
      for (const stream of streams)
        publish.run(
          stream.name,
          JSON.stringify(
            withFiles(stream)
              ? {
                  ...stream.jsonSchema,
                  properties: {
                    ...(stream.jsonSchema.properties as object | undefined),
                    attachmentRef,
                  },
                }
              : stream.jsonSchema,
          ),
          JSON.stringify(source.coverage(stream)),
        );
    }
    try {
      const results = await pipeline.run();
      const finishedAt = new Date().toISOString();
      return {
        state: 'succeeded',
        startedAt,
        finishedAt,
        lastSucceededAt: finishedAt,
        streams: results.map((result) => ({
          name: result.copy.from.name,
          count: result.count,
          deleted: result.deleted,
        })),
      };
    } catch (error) {
      if (!(error instanceof PipelineError)) throw error;
      return {
        state: error.results.some((result) => copyStatus(result) !== 'failed')
          ? 'partial'
          : 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        lastSucceededAt,
        error: failure(error),
        streams: error.results.map((result) => ({
          name: result.copy.from.name,
          state: copyStatus(result),
          count: result.count,
          deleted: result.deleted,
          errors: result.failures.map((item) => String(item.error)),
        })),
      };
    }
  } catch (error) {
    return {
      state: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      lastSucceededAt,
      error: failure(error),
    };
  }
}
