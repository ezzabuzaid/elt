import type { RecordDraft } from '@workspace/elt';
import type { GroupMembersChange } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { jid, text, integer, instant } = whatsappFields;

const properties = {
  groupJid: {
    ...jid,
    description: 'The group; refers to chats.jid (ZGROUPJID).',
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
  readonly primaryKey = ['groupJid', 'changeDate', 'changeType', 'memberJids'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per change to a group’s members WhatsApp keeps (ZWAGROUPMEMBERSCHANGE). Primary key groupJid, changeDate, changeType, memberJids.',
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
