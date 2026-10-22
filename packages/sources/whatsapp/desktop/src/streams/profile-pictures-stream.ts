import type { RecordDraft, SchemaRecord } from '@workspace/elt';
import {
  type ProfilePicture,
  profilePictureFile,
} from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { jid, boolean, nullableText, nullableInstant } = whatsappFields;

const properties = {
  jid: {
    ...jid,
    description: 'The person or group (ZJID); the primary key.',
  },
  pictureId: {
    ...nullableText,
    description:
      'The picture’s ID; a new one marks a new picture (ZPICTUREID).',
  },
  path: {
    ...nullableText,
    description:
      'Where WhatsApp keeps the picture, relative to its container; the file on disk adds .thumb (ZPATH).',
  },
  availableLocally: {
    ...boolean,
    description:
      'Whether the picture’s thumbnail was on this Mac when the record was read. File bytes are exported only when true.',
  },
  requestDate: {
    ...nullableInstant,
    description: 'When WhatsApp last fetched the picture, UTC (ZREQUESTDATE).',
  },
} as const;

export class ProfilePicturesStream extends WhatsAppStream<
  typeof properties,
  ProfilePicture
> {
  readonly name = 'profilePictures';
  readonly store = 'chatStorage';
  readonly primaryKey = ['jid'];
  readonly supportsFileTransfer = true;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per person or group whose profile picture WhatsApp has looked up (ZWAPROFILEPICTUREITEM), with the thumbnail it keeps, the only copy on this Mac. Primary key jid. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): Iterable<ProfilePicture> {
    return scan.chatStorage.profilePictures;
  }

  protected record({
    file,
    ...picture
  }: ProfilePicture): RecordDraft<typeof properties> {
    return { ...picture, availableLocally: file !== null };
  }

  override file(
    { path, availableLocally }: SchemaRecord<typeof properties>,
    scan: WhatsAppScan,
  ): string | null {
    return availableLocally && path !== null
      ? profilePictureFile(scan.container, path)
      : null;
  }
}
