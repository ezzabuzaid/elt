import { homedir } from 'node:os';

import { Connection } from '@eltjs/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
} from '@eltjs/elt-postgresql';
import { AccountsStore, accountsStorePath } from '@eltjs/sdk-apple-accounts';
import { mailDirectory } from '@eltjs/sdk-apple-mail';
import { AppleMailSource } from '@eltjs/source-apple-mail/apple-mail-source';

import { warehouseUrl } from '../warehouse.ts';
import { martsCopy } from './marts-copy.ts';

const source = new AppleMailSource({
  path: mailDirectory(homedir()),
  accounts: new AccountsStore(accountsStorePath(homedir())),
});
const destination = new PostgresDestination({ url: warehouseUrl });

export default new Connection({
  name: 'apple-mail',
  source,
  destination,
  checkpoints: new PostgresCheckpointStore({ url: warehouseUrl }),
  steps: [
    source.messages,
    source.addresses,
    source.subjects,
    source.messageParts,
    source.messageGlobalData,
    source.conversationMessages,
  ].map(martsCopy(destination, 'mail')),
});
