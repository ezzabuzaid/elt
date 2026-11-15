import { whatsappFields } from './whatsapp-stream.ts';

const { integer } = whatsappFields;

// The message a record decoded from its receipt info is on, and the record's
// place in the list it was decoded from: together the record's key.
export const onMessageFields = {
  messageId: {
    ...integer,
    description: 'The message the record is on; refers to messages.id.',
  },
  position: {
    ...integer,
    minimum: 0,
    description:
      'The record’s place in the list the message’s receipt info holds, from 0.',
  },
} as const;
