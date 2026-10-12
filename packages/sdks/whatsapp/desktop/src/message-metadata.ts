import { ProtobufMessage } from '@workspace/codec-protobuf';

// The message a reply quotes: its stanza ID, which names a message of the
// same chat, and its sender as the reply recorded it (a LID where the quoted
// row may hold a phone JID).
export type QuotedMessage = {
  readonly stanzaId: string;
  readonly senderJid: string | null;
};

// The message's metadata (ZWAMEDIAITEM.ZMETADATA), a protobuf WhatsApp writes
// with no published schema, so only fields the store bears out are read:
// field 5 is the quoted message's stanza ID (99% of them name a message in
// the same chat) and field 6 its sender.
export function quotedMessage(metadata: Uint8Array): QuotedMessage | null {
  const message = new ProtobufMessage(metadata);
  const stanzaId = message.string(5);
  if (stanzaId === undefined) return null;
  return { stanzaId, senderJid: message.string(6) ?? null };
}
