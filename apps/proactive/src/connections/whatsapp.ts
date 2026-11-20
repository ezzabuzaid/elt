import { homedir } from 'node:os';

import { Connection } from '@eltjs/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
} from '@eltjs/elt-postgresql';
import { whatsappContainer } from '@eltjs/sdk-whatsapp-desktop';
import { WhatsAppDesktopSource } from '@eltjs/source-whatsapp-desktop/whatsapp-desktop-source';

import { warehouseUrl } from '../warehouse.ts';
import { martsCopy } from './marts-copy.ts';

const source = new WhatsAppDesktopSource({
  container: whatsappContainer(homedir()),
});
const destination = new PostgresDestination({ url: warehouseUrl });

export default new Connection({
  name: 'whatsapp',
  source,
  destination,
  checkpoints: new PostgresCheckpointStore({ url: warehouseUrl }),
  // The personal chats, with who the people in them are.
  steps: [
    source.chats,
    source.messages,
    source.messageReactions,
    source.users,
    source.contacts,
    source.pushNames,
  ].map(martsCopy(destination, 'whatsapp')),
});
