// What the Slack app keeps on this Mac for one signed-in workspace: the state
// its client saved the last time it persisted, which covers the workspace's
// channels and people but only the messages the client had loaded.

export type SlackWorkspace = {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly url: string | null;
  readonly emailDomain: string | null;
  // Slack's plan code; empty for the free plan.
  readonly plan: string | null;
  readonly createdAt: string | null;
  readonly iconUrl: string | null;
};

export type SlackChannelKind = 'public' | 'private' | 'im' | 'mpim';

// A note a channel carries, such as its topic or purpose.
export type SlackChannelNote = {
  readonly value: string | null;
  readonly setBy: string | null;
  readonly setAt: string | null;
};

export type SlackChannel = {
  readonly id: string;
  // The direct message's other person, for an im.
  readonly name: string | null;
  readonly kind: SlackChannelKind;
  readonly imUserId: string | null;
  readonly createdAt: string | null;
  readonly creatorId: string | null;
  readonly updatedAt: string | null;
  readonly isArchived: boolean | null;
  readonly isGeneral: boolean | null;
  readonly isMember: boolean | null;
  readonly isExternallyShared: boolean | null;
  readonly isOrgShared: boolean | null;
  readonly topic: SlackChannelNote;
  readonly purpose: SlackChannelNote;
  readonly previousNames: readonly string[];
  // The members the client knows, which it holds for group DMs.
  readonly memberIds: readonly string[];
  // The newest message this user has read, and the newest message.
  readonly lastReadTs: string | null;
  readonly latestTs: string | null;
};

export type SlackMember = {
  readonly id: string;
  readonly teamId: string | null;
  readonly name: string | null;
  readonly realName: string | null;
  readonly displayName: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly title: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly pronouns: string | null;
  readonly timeZone: string | null;
  readonly statusText: string | null;
  readonly statusEmoji: string | null;
  readonly statusExpiresAt: string | null;
  readonly avatarUrl: string | null;
  readonly botId: string | null;
  readonly appId: string | null;
  readonly isBot: boolean | null;
  readonly isAppUser: boolean | null;
  readonly isDeleted: boolean | null;
  readonly isAdmin: boolean | null;
  readonly isOwner: boolean | null;
  readonly isPrimaryOwner: boolean | null;
  readonly isRestricted: boolean | null;
  readonly isUltraRestricted: boolean | null;
  readonly isInvited: boolean | null;
  readonly isSelf: boolean | null;
  readonly updatedAt: string | null;
};

export type SlackBot = {
  readonly id: string;
  readonly name: string | null;
  readonly appId: string | null;
  readonly isDeleted: boolean | null;
  readonly updatedAt: string | null;
};

export type SlackApp = {
  readonly id: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly developerName: string | null;
  readonly appType: string | null;
  readonly url: string | null;
  readonly isInstalled: boolean | null;
  readonly isDistributed: boolean | null;
  readonly isWorkflowApp: boolean | null;
};

export type SlackReaction = {
  readonly name: string;
  // The emoji without its skin tone.
  readonly baseName: string | null;
  readonly count: number;
  // The people the client knows reacted; fewer than count on busy messages.
  readonly userIds: readonly string[];
};

// A link preview or shared message Slack shows under a message.
export type SlackAttachment = {
  readonly id: string | null;
  readonly fallback: string | null;
  readonly pretext: string | null;
  readonly text: string | null;
  readonly fromUrl: string | null;
  readonly authorId: string | null;
  readonly authorName: string | null;
  readonly authorLink: string | null;
  readonly channelId: string | null;
  readonly messageTs: string | null;
  readonly footer: string | null;
  readonly color: string | null;
  readonly appId: string | null;
  readonly botId: string | null;
  readonly isMessageUnfurl: boolean | null;
  readonly isAppUnfurl: boolean | null;
  // As Slack holds them.
  readonly fieldsJson: string | null;
  readonly blocksJson: string | null;
};

export type SlackMessage = {
  readonly channelId: string;
  // Slack's id for the message within its channel: seconds and microseconds.
  readonly ts: string;
  readonly sentAt: string;
  readonly type: string;
  readonly subtype: string | null;
  readonly userId: string | null;
  readonly botId: string | null;
  readonly text: string | null;
  readonly threadTs: string | null;
  readonly replyCount: number | null;
  readonly replyUserIds: readonly string[];
  readonly latestReplyTs: string | null;
  readonly editedBy: string | null;
  readonly editedTs: string | null;
  readonly clientMessageId: string | null;
  readonly isLocked: boolean | null;
  // Hidden by the workspace's plan, past its history limit.
  readonly isBeyondPlanLimit: boolean | null;
  // Saved for later: its state in the user's Later list, such as in_progress,
  // its to-do state, such as saved, and whether the user archived it there.
  readonly savedState: string | null;
  readonly savedTodoState: string | null;
  readonly isSavedArchived: boolean | null;
  // As Slack holds them.
  readonly blocksJson: string | null;
  readonly attachments: readonly SlackAttachment[];
  readonly reactions: readonly SlackReaction[];
  // The files it shares (SlackFile.id).
  readonly fileIds: readonly string[];
};

// Where a file was shared: the conversation, and the message's ts there.
export type SlackFileShare = {
  readonly channelId: string;
  readonly ts: string;
  readonly isPrivate: boolean;
  readonly sharedBy: string | null;
};

// A file the app knows: one shared in a conversation, a snippet, a canvas or
// a List. The app keeps its metadata, never its bytes.
export type SlackFile = {
  readonly id: string;
  readonly name: string | null;
  readonly title: string | null;
  readonly mimetype: string | null;
  readonly filetype: string | null;
  readonly prettyType: string | null;
  // hosted, external, snippet, post, list or canvas.
  readonly mode: string | null;
  readonly size: number | null;
  readonly userId: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly editedAt: string | null;
  readonly isExternal: boolean | null;
  readonly externalType: string | null;
  readonly isPublic: boolean | null;
  readonly isDeleted: boolean | null;
  readonly isTombstoned: boolean | null;
  readonly urlPrivate: string | null;
  readonly permalink: string | null;
  // The first lines of a text file, as Slack previews it.
  readonly preview: string | null;
  // A snippet's whole text.
  readonly content: string | null;
  readonly lines: number | null;
  readonly durationMs: number | null;
  readonly width: number | null;
  readonly height: number | null;
  // A List's columns and views, and a recording's transcript, as Slack holds
  // them.
  readonly listMetadataJson: string | null;
  readonly transcriptionJson: string | null;
  readonly shares: readonly SlackFileShare[];
};

// A row of a Slack List, a file whose mode is list.
export type SlackListRecord = {
  readonly listId: string;
  readonly id: string;
  // The row's sort key in the List.
  readonly position: string | null;
  readonly parentRecordId: string | null;
  readonly threadTs: string | null;
  readonly createdAt: string | null;
  readonly createdBy: string | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly isArchived: boolean | null;
  // Its cells by column ID, as Slack holds them; the List's file names the
  // columns in its listMetadataJson.
  readonly fieldsJson: string | null;
};

// A message pinned in a conversation.
export type SlackPin = {
  readonly channelId: string;
  readonly ts: string;
  // What is pinned: message.
  readonly type: string;
  readonly pinnedBy: string | null;
  readonly pinnedAt: string | null;
};

export type SlackChannelSection = {
  readonly id: string;
  readonly type: string;
  readonly name: string | null;
  readonly emoji: string | null;
  // Where the sidebar shows it, from 0.
  readonly position: number;
  readonly channelIds: readonly string[];
};

export type SlackThreadSubscription = {
  readonly channelId: string;
  readonly threadTs: string;
  readonly isSubscribed: boolean | null;
  readonly lastReadTs: string | null;
};

// Whether the signed-in user is in a user group, as the client checked; it
// keeps neither the group's name nor its members.
export type SlackUserGroupMembership = {
  readonly userGroupId: string;
  readonly isMember: boolean | null;
};

export type SlackPreference = {
  readonly scope: 'user' | 'team';
  readonly name: string;
  // As Slack holds it.
  readonly valueJson: string;
};

export type SlackClient = {
  readonly workspace: SlackWorkspace;
  readonly userId: string;
  readonly channels: readonly SlackChannel[];
  readonly members: readonly SlackMember[];
  readonly bots: readonly SlackBot[];
  readonly apps: readonly SlackApp[];
  // The channel messages the client holds, without thread replies.
  readonly messages: readonly SlackMessage[];
  // The thread replies the client holds, which it loads when a thread is
  // opened and records no range of.
  readonly threadReplies: readonly SlackMessage[];
  readonly files: readonly SlackFile[];
  readonly listRecords: readonly SlackListRecord[];
  readonly pins: readonly SlackPin[];
  readonly channelSections: readonly SlackChannelSection[];
  readonly threadSubscriptions: readonly SlackThreadSubscription[];
  readonly userGroupMemberships: readonly SlackUserGroupMembership[];
  readonly preferences: readonly SlackPreference[];
  // Whether the client holds a channel's history at this ts: a message there
  // that the client no longer holds was deleted, not dropped from its cache.
  holds(channelId: string, ts: string): boolean;
  // Whether the client loaded a conversation's whole pin list: a pin it no
  // longer lists there was removed.
  holdsPins(channelId: string): boolean;
};
