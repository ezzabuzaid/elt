import { join } from 'node:path';
import { Connection, Copy, LocalFiles, type Source } from 'elt';
import {
  PostgresCheckpointStore,
  PostgresColumns,
  PostgresDestination,
  type PostgresTable,
} from 'elt-postgresql';

const snake = (name: string) =>
  name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

// Every stream of one Apple source, loaded incrementally into its own schema
// beside its checkpoints, and read as marts.<name>_<stream> with the stream's
// own descriptions. Exported files are kept under outputs/apple-<name>-files.
export async function warehouseConnection(
  name: string,
  source: Source,
  { url, outputs }: { url: string; outputs: string },
): Promise<Connection<PostgresTable>> {
  const schema = `apple_${name}`;
  const destination = new PostgresDestination({ url, schema });
  const files = new LocalFiles({
    directory: join(outputs, `apple-${name}-files`),
  });
  const { streams } = await source.discover();
  return new Connection({
    name: `apple-${name}`,
    source,
    destination,
    checkpoints: new PostgresCheckpointStore({ url, schema }),
    steps: streams.map(
      (stream) =>
        new Copy(
          stream,
          destination
            .table(
              `raw_${stream.name}`,
              stream.supportsFileTransfer
                ? (columns) => [
                    ...PostgresColumns.fromSchema(stream.jsonSchema),
                    columns
                      .text('attachmentRef')
                      .from(stream.file.store(files)),
                  ]
                : undefined,
            )
            .withReaderView('marts', `${name}_${snake(stream.name)}`),
          {
            id: `apple-${name}:${stream.name}`,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          },
        ),
    ),
  });
}
