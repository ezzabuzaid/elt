import type { RecordDraft } from '@eltjs/elt';
import type { GroupMembersChange } from '@eltjs/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, rowId, whatsappFields } from '../whatsapp-stream.ts';

const { jid, text, integer, instant } = whatsappFields;

const properties = {
  id: rowId('ZWAGROUPMEMBERSCHANGE'),
  groupJid: {
    ...jid,
    description: 'The group’s JID, as chats.jid holds it (ZGROUPJID).',
  },
  changeDate: {
    ...instant,
    description: 'When the members changed, UTC (ZCHANGEDATE).',
  },
  changeType: {
    ...integer,
    description: 'WhatsApp’s undocumented code for the change (ZCHANGETYPE).',
  },
  memberJids: {
    ...text,
    minLength: 1,
    description:
      'The members the change is about, as WhatsApp lists them (ZMEMBERJIDS).',
  },
} as const;

export class GroupMembersChangesStream extends WhatsAppStream<
  typeof properties,
  GroupMembersChange
> {
  readonly name = 'groupMembersChanges';
  readonly store = 'chatStorage';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per change to a group’s members WhatsApp keeps (ZWAGROUPMEMBERSCHANGE). Primary key id. WhatsApp writes a few changes a second time, on a row and record of their own.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): Iterable<GroupMembersChange> {
    return scan.chatStorage.groupMembersChanges;
  }

  protected record(change: GroupMembersChange): RecordDraft<typeof properties> {
    return { ...change };
  }
}
