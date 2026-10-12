import type { Fields } from './fields.ts';
import type { TeamsFolder } from './teams-client.ts';

// A folder of the chat list, the user's own or one Teams keeps, such as
// Favorites, with the conversations it groups.
export function readFolder(folder: Fields): TeamsFolder {
  return {
    id: folder.requiredString('id'),
    name: folder.string('name'),
    folderType: folder.string('folderType'),
    sortType: folder.string('sortType'),
    emoji: folder.string('emojiCode'),
    isHidden: folder.boolean('isHidden'),
    isDeleted: folder.boolean('isDeleted'),
    createdAt: folder.milliseconds('createdTime'),
    conversations: folder.list('conversations').map((conversation) => ({
      conversationId: conversation.requiredString('id'),
      addedAt: conversation.milliseconds('createdTime'),
    })),
  };
}
