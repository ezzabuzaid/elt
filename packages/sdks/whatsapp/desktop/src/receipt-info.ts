import { ProtobufMessage } from '@workspace/codec-protobuf';

import { unixSecondInstant } from './values.ts';

// One recipient's acknowledgements of a message: when its device received
// it, and when the person read it or played its audio. A missing time is an
// acknowledgement that has not arrived.
export type Receipt = {
  readonly recipientJid: string;
  readonly deliveredAt: string | null;
  readonly readAt: string | null;
  readonly playedAt: string | null;
};

// One person's reaction to a message. WhatsApp keeps a reaction its sender
// withdrew, with no emoji.
export type Reaction = {
  readonly stanzaId: string;
  // null for the account's own reaction.
  readonly senderJid: string | null;
  readonly isFromMe: boolean;
  readonly emoji: string | null;
  readonly reactedAt: string;
};

// How many people reacted with one emoji to a channel post, which keeps
// counts rather than who reacted.
export type ReactionCount = {
  readonly emoji: string;
  readonly count: number;
};

// The servers a receipt's packed JID names, by its first byte, as the store's
// own JIDs show them: 0x81 for phone numbers, 0x8c for LIDs, 0x83 for bots.
const packedServers = new Map([
  [0x81, 's.whatsapp.net'],
  [0x8c, 'lid'],
  [0x83, 'bot'],
]);

// A receipt names its recipient in nine bytes or fewer: the server's byte,
// then the user part as binary-coded decimal, padded with an F nibble.
function packedJid(bytes: Uint8Array): string {
  const [first] = bytes;
  const server = first === undefined ? undefined : packedServers.get(first);
  const digits = Buffer.from(bytes.subarray(1))
    .toString('hex')
    .replace(/f$/, '');
  if (server === undefined || !/^\d+$/.test(digits))
    throw new TypeError(
      `A WhatsApp receipt names a recipient this reader does not read (${Buffer.from(bytes).toString('hex')})`,
    );
  return `${digits}@${server}`;
}

// An instant to the second, from the receipt's base time in Unix seconds and
// an offset in seconds from it.
function offsetInstant(
  base: number | undefined,
  offset: number | undefined,
): string | null {
  if (offset === undefined) return null;
  if (base === undefined)
    throw new TypeError('A WhatsApp receipt has an offset but no base time');
  return unixSecondInstant(base + offset);
}

// The value WhatsApp's WAMessageReceiptInfoTransformer stores per message
// (ZWAMESSAGEINFO.ZRECEIPTINFO): a protobuf with no published schema, read by
// the field numbers the store's own values bear out. Field 3 is the message's
// time in Unix seconds; each field 2 is one recipient, whose fields 4, 5 and
// 6 are seconds after it until delivery, reading and playing (a read message
// has status 8, a played voice note 5); field 7 holds the reactions, each
// with its stanza ID (1), sender (2, absent exactly when field 6 marks the
// account's own), emoji (3) and time in Unix milliseconds (4), and a channel
// post's counts per emoji (field 7.3).
export class ReceiptInfo {
  readonly receipts: readonly Receipt[];
  readonly reactions: readonly Reaction[];
  readonly reactionCounts: readonly ReactionCount[];

  constructor(bytes: Uint8Array) {
    const info = new ProtobufMessage(bytes);
    const base = info.uint(3);
    this.receipts = info.messages(2).map((recipient) => {
      const jid = recipient.bytes(1);
      if (jid === undefined)
        throw new TypeError('A WhatsApp receipt names no recipient');
      return {
        recipientJid: packedJid(jid),
        deliveredAt: offsetInstant(base, recipient.uint(4)),
        readAt: offsetInstant(base, recipient.uint(5)),
        playedAt: offsetInstant(base, recipient.uint(6)),
      };
    });
    const reactions = info.message(7);
    this.reactions = (reactions?.messages(1) ?? []).map((reaction) => {
      const stanzaId = reaction.string(1);
      const emoji = reaction.string(3);
      const reactedAt = reaction.uint(4);
      if (stanzaId === undefined || reactedAt === undefined)
        throw new TypeError('A WhatsApp reaction lacks its ID or time');
      return {
        stanzaId,
        senderJid: reaction.string(2) ?? null,
        isFromMe: reaction.uint(6) === 1,
        emoji: emoji ?? null,
        reactedAt: new Date(reactedAt).toISOString(),
      };
    });
    this.reactionCounts = (reactions?.message(3)?.messages(1) ?? []).map(
      (counted) => {
        const emoji = counted.string(1);
        const count = counted.uint(2);
        if (emoji === undefined || count === undefined)
          throw new TypeError('A WhatsApp reaction count lacks its emoji');
        return { emoji, count };
      },
    );
  }
}
