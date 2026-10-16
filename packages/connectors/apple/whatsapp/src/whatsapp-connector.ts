import { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import type { Choice } from '@workspace/connector-apple-connector/choice';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import { WhatsAppDesktopSource } from '@workspace/source-whatsapp-desktop/whatsapp-desktop-source';

import { whatsappCounterparts } from './whatsapp-counterparts.ts';

export default class WhatsAppConnector extends AppleConnector {
  readonly datedBy = 'date sent';
  readonly fullDiskAccess = true;
  override readonly note =
    'WhatsApp saves messages to this Mac only while it runs, so messages sent while it is closed are imported once it has run again.';
  protected readonly choices: readonly Choice[] = [
    {
      stream: 'chats',
      scope: 'collectionIds',
      title: 'chats',
      id: (row) => String(row.jid),
      label: (row) => String(row.partnerName ?? row.jid),
    },
  ];
  // What belongs to no chat: who people are, calls, statuses, businesses,
  // stickers and settings.
  protected readonly unscoped = [
    'pushNames',
    'profilePictures',
    'blockedContacts',
    'contacts',
    'users',
    'calls',
    'callParticipants',
    'businessProfiles',
    'businessVerifiedNames',
    'businessCategories',
    'businessHours',
    'businessServiceAreas',
    'businessBotPrompts',
    'statuses',
    'stickerPacks',
    'stickers',
    'favoriteStickers',
    'recentStickers',
    'privacySettings',
    'disappearingModes',
    'linkedProfiles',
    'changedNumbers',
  ];
  protected readonly storeCopies = [];

  protected override views(copied: ReadonlySet<string>) {
    return [whatsappCounterparts(copied)];
  }

  protected access(): string {
    return 'Open WhatsApp and let it run: it keeps what it has synced from your phone, and saves new messages to this Mac while it runs.';
  }

  protected source(scope: ImportScope) {
    return new WhatsAppDesktopSource(undefined, scope);
  }
}
