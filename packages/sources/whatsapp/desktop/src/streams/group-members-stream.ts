import type { RecordDraft } from '@workspace/elt';
import type { GroupMember } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { jid, nullableText, nullableInteger, nullableBoolean } = whatsappFields;

const properties = {
  groupJid: {
    ...jid,
    description: 'The group; refers to chats.jid.',
  },
  memberJid: {
    ...jid,
    description:
      'The member, as <LID>@lid, <number>@s.whatsapp.net or a bot’s …@bot (ZMEMBERJID).',
  },
  contactName: {
    ...nullableText,
    description: 'The name WhatsApp shows for the member (ZCONTACTNAME).',
  },
  firstName: {
    ...nullableText,
    description: 'The member’s first name from the address book (ZFIRSTNAME).',
  },
  contactIdentifier: {
    ...nullableText,
    description:
      'The member’s other WhatsApp JID when WhatsApp records it, as for a chat (ZCONTACTIDENTIFIER); NULL in every row on 2026-10-15.',
  },
  contactAbId: {
    ...nullableInteger,
    description: 'The member’s address book record number (ZCONTACTABID).',
  },
  isActive: {
    ...nullableBoolean,
    description: 'Whether the person is still in the group (ZISACTIVE).',
  },
  isAdmin: {
    ...nullableBoolean,
    description: 'Whether the person is a group admin (ZISADMIN).',
  },
} as const;

export class GroupMembersStream extends WhatsAppStream<
  typeof properties,
  GroupMember
> {
  readonly name = 'groupMembers';
  readonly store = 'chatStorage';
  readonly primaryKey = ['groupJid', 'memberJid'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per person WhatsApp lists for a group, including those who left (isActive false). Primary key groupJid, memberJid.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): readonly GroupMember[] {
    return scan.chatStorage.groupMembers;
  }

  protected record(member: GroupMember): RecordDraft<typeof properties> {
    return { ...member };
  }
}
