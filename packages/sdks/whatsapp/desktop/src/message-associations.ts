import { type Snapshot } from '@zukhruf/sqlite-snapshot';

import { appDatabase } from './app-database.ts';
import { requiredText } from './values.ts';

// A message WhatsApp shows as part of another of the same chat, such as a
// photo of an album, by the kind of link (type).
export type MessageAssociation = {
  readonly chatJid: string;
  readonly stanzaId: string;
  readonly type: number;
  readonly parentStanzaId: string;
  readonly sort: number;
};

const requiredColumns = {
  message_parent_association: [
    'stanza_id',
    'parent_stanza_id',
    'type',
    'sort',
    'chat_jid',
  ],
};

// ExtChatDB/ExtChatDatabase.sqlite as of one moment. Its other tables
// (threads, AI threads, broadcast campaigns, key stores) are empty here or
// hold keys and queues, and are not read.
export class MessageAssociationsSnapshot implements Disposable {
  readonly #database: Snapshot;

  constructor(path: string) {
    this.#database = appDatabase.snapshot(path, requiredColumns);
  }

  associations(): IteratorObject<MessageAssociation, undefined> {
    return this.#database
      .iterate(
        `SELECT chat_jid AS chatJid, stanza_id AS stanzaId, type,
                parent_stanza_id AS parentStanzaId, sort
         FROM message_parent_association ORDER BY chat_jid, sort, stanza_id`,
      )
      .map((row) => ({
        chatJid: requiredText(
          row.chatJid,
          'A WhatsApp association has no chat',
        ),
        stanzaId: requiredText(
          row.stanzaId,
          'A WhatsApp association has no message',
        ),
        type: Number(row.type),
        parentStanzaId: requiredText(
          row.parentStanzaId,
          'A WhatsApp association has no parent',
        ),
        sort: Number(row.sort),
      }));
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}
