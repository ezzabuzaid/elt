import { homedir } from 'node:os';

import { Connection } from '@eltjs/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
} from '@eltjs/elt-postgresql';
import { chatDatabasePath } from '@eltjs/sdk-apple-messages';
import { AppleMessagesSource } from '@eltjs/source-apple-messages/apple-messages-source';

import { warehouseUrl } from '../warehouse.ts';
import { martsCopy } from './marts-copy.ts';

// macOS grants Full Disk Access, which chat.db needs, to the terminal that
// runs proactive.
const source = new AppleMessagesSource({
  path: chatDatabasePath(homedir()),
  home: homedir(),
});
const destination = new PostgresDestination({
  url: warehouseUrl,
  schema: 'apple_messages',
});
const { streams } = await source.discover();

export default new Connection({
  name: 'apple-messages',
  source,
  destination,
  checkpoints: new PostgresCheckpointStore({
    url: warehouseUrl,
    schema: 'apple_messages',
  }),
  steps: streams.map(martsCopy(destination, 'messages')),
});
