import { homedir } from 'node:os';

import { Connection } from '@eltjs/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
} from '@eltjs/elt-postgresql';
import { slackDesktopDirectory } from '@eltjs/sdk-slack-desktop';
import { SlackDesktopSource } from '@eltjs/source-slack-desktop/slack-desktop-source';

import { warehouseUrl } from '../warehouse.ts';
import { martsCopy } from './marts-copy.ts';

const source = new SlackDesktopSource({
  directory: slackDesktopDirectory(homedir()),
});
const destination = new PostgresDestination({ url: warehouseUrl });

export default new Connection({
  name: 'slack',
  source,
  destination,
  checkpoints: new PostgresCheckpointStore({ url: warehouseUrl }),
  steps: [source.messages, source.threadReplies].map(
    martsCopy(destination, 'slack'),
  ),
});
