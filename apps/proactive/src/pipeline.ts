import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
  installPostgresCatalog,
} from '@workspace/elt-postgresql';
import { AppleMessagesSource } from '@workspace/source-apple-messages/apple-messages-source';

if (process.platform !== 'darwin')
  throw new Error('proactive reads Apple Messages on a Mac.');

const warehouseUrl = 'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';
const schema = 'apple_messages';

// Messages, every stream, loaded into its raw schema; readers see each stream
// as marts.messages_<stream>. macOS grants Full Disk Access, which chat.db
// needs, to the terminal that runs proactive.
const source = new AppleMessagesSource();
const destination = new PostgresDestination({ url: warehouseUrl, schema });
const history = new PostgresSyncHistory({ url: warehouseUrl });
await history.install();
await installPostgresCatalog({ url: warehouseUrl, schema: 'marts' });
const { streams } = await source.discover();

export default new Pipeline({
  history,
  connections: [
    new Connection({
      name: 'apple-messages',
      source,
      destination,
      checkpoints: new PostgresCheckpointStore({ url: warehouseUrl, schema }),
      steps: streams.map(
        (stream) =>
          new Copy(
            stream,
            destination
              .table(`raw_${stream.name}`)
              .withReaderView(
                'marts',
                `messages_${stream.name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
              ),
            {
              id: `messages:${stream.name}`,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            },
          ),
      ),
    }),
  ],
});
