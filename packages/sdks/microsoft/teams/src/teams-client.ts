// What the Microsoft Teams app keeps on this Mac for one signed-in account:
// the web client's IndexedDB caches, which hold the account's whole
// conversation list and roster but only the messages the client has loaded.

export type TeamsAccount = {
  // The Microsoft Entra object IDs of the user and of the tenant signed in to.
  readonly userId: string;
  readonly tenantId: string;
  // The user's Teams ID: 8:orgid:<userId>.
  readonly mri: string;
  // The tenant's verified domains.
  readonly tenantDomains: readonly string[];
};

export type TeamsMember = {
  // A person's or bot's Teams ID (TeamsPerson.mri).
  readonly id: string;
  readonly role: string | null;
  readonly isBot: boolean;
  readonly isReader: boolean | null;
  // From when the member sees the conversation's history.
  readonly shareHistoryAt: string | null;
};

export type TeamsConversation = {
  readonly id: string;
  // Teams' own kind: Chat, Meeting, Space (a team), Topic (a channel),
  // StreamOfNotes (the user's own notes), EngageCommunity, and the
  // Conversation and Thread feeds the client keeps for itself.
  readonly type: string;
  readonly topic: string | null;
  // The title the client shows for a chat without a topic, from its members.
  readonly title: string | null;
  readonly description: string | null;
  // The team a channel belongs to (the team's own conversation id), and for
  // a team's own conversation, the team's name.
  readonly teamId: string | null;
  readonly teamName: string | null;
  readonly creatorId: string | null;
  readonly createdAt: string | null;
  readonly lastMessageAt: string | null;
  // When the user last read the conversation.
  readonly lastReadAt: string | null;
  readonly isRead: boolean | null;
  readonly isFavorite: boolean | null;
  readonly isPinned: boolean | null;
  readonly isHidden: boolean | null;
  readonly isDeleted: boolean | null;
  readonly visibility: string | null;
  readonly subType: string | null;
  readonly memberCount: number | null;
  // Null when the client keeps no member list for the conversation, as for
  // a channel, whose members are its team's.
  readonly members: readonly TeamsMember[] | null;
  // The ids of the messages pinned to the conversation, in its order.
  readonly pinnedMessageIds: readonly string[];
};

export type TeamsReaction = {
  readonly emoji: string;
  readonly userId: string;
  readonly reactedAt: string | null;
};

export type TeamsMention = {
  // The mention's place in the message, which its content refers to.
  readonly position: number;
  readonly mentionedId: string;
  // person, everyone, channel, team or tag.
  readonly kind: string | null;
  readonly displayName: string | null;
};

export type TeamsMessageFile = {
  readonly id: string;
  readonly name: string | null;
  readonly fileType: string | null;
  readonly title: string | null;
  readonly url: string | null;
  readonly siteUrl: string | null;
  readonly shareUrl: string | null;
  // Where the file lives: teams for a channel's files, p2p for a chat's.
  readonly service: string | null;
};

export type TeamsMessageLink = {
  readonly position: number;
  readonly url: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly previewUrl: string | null;
};

export type TeamsQuote = {
  readonly messageId: string;
  readonly senderId: string | null;
  readonly sentAt: string | null;
  readonly threadId: string | null;
};

export type TeamsMessage = {
  readonly conversationId: string;
  // The thread's first message: the message itself, except for a reply in a
  // channel.
  readonly threadId: string;
  // Teams' id for the message within its conversation: when the service
  // received it, in milliseconds.
  readonly id: string;
  readonly sentAt: string;
  readonly senderId: string | null;
  readonly senderName: string | null;
  readonly messageType: string;
  readonly contentType: string | null;
  // As Teams holds it, HTML for rich text; null once deleted.
  readonly content: string | null;
  readonly subject: string | null;
  readonly importance: string | null;
  readonly editedAt: string | null;
  readonly deletedAt: string | null;
  readonly isFromUser: boolean | null;
  // Adaptive cards, as Teams holds them.
  readonly cardsJson: string | null;
  readonly reactions: readonly TeamsReaction[];
  readonly mentions: readonly TeamsMention[];
  readonly files: readonly TeamsMessageFile[];
  readonly links: readonly TeamsMessageLink[];
  readonly quotes: readonly TeamsQuote[];
  readonly pinnedBy: string | null;
  readonly pinnedAt: string | null;
};

type TeamsCallParticipant = {
  readonly id: string;
  readonly type: string | null;
  readonly tenantId: string | null;
};

export type TeamsCallLog = {
  // The log's message in the client's call log feed.
  readonly id: string;
  readonly callId: string;
  readonly startedAt: string | null;
  readonly connectedAt: string | null;
  readonly endedAt: string | null;
  readonly direction: string | null;
  readonly callType: string | null;
  // accepted, declined or missed.
  readonly state: string | null;
  readonly originatorId: string | null;
  readonly originatorName: string | null;
  readonly targetId: string | null;
  readonly targetType: string | null;
  // The meeting or chat the call took place in.
  readonly conversationId: string | null;
  readonly messageId: string | null;
  readonly forwardedTo: string | null;
  readonly participants: readonly TeamsCallParticipant[];
};

export type TeamsActivity = {
  // The client feed the activity came from: notifications or annotations.
  readonly feed: string;
  readonly id: string;
  readonly activityId: string | null;
  readonly type: string;
  readonly subtype: string | null;
  readonly occurredAt: string;
  readonly sourceConversationId: string | null;
  readonly sourceThreadId: string | null;
  readonly sourceMessageId: string | null;
  readonly sourceUserId: string | null;
  readonly sourceUserName: string | null;
  readonly sourceTopic: string | null;
  readonly preview: string | null;
  readonly isRead: boolean | null;
};

export type TeamsPerson = {
  readonly mri: string;
  readonly objectId: string | null;
  readonly type: string | null;
  readonly displayName: string | null;
  readonly givenName: string | null;
  readonly surname: string | null;
  readonly email: string | null;
  readonly userPrincipalName: string | null;
  readonly jobTitle: string | null;
  readonly department: string | null;
  readonly companyName: string | null;
  readonly officeLocation: string | null;
  readonly userLocation: string | null;
  readonly tenantName: string | null;
  readonly userType: string | null;
};

type TeamsAttendee = {
  readonly address: string;
  readonly name: string | null;
  readonly type: string | null;
  readonly role: string | null;
  readonly response: string | null;
};

export type TeamsMeeting = {
  readonly id: string;
  readonly iCalUid: string | null;
  readonly seriesMasterId: string | null;
  readonly eventType: string | null;
  readonly subject: string | null;
  readonly startAt: string;
  readonly endAt: string;
  readonly timeZone: string | null;
  readonly location: string | null;
  readonly organizerName: string | null;
  readonly organizerAddress: string | null;
  readonly isOnlineMeeting: boolean | null;
  readonly joinUrl: string | null;
  readonly conversationId: string | null;
  readonly myResponse: string | null;
  readonly showAs: string | null;
  readonly isCancelled: boolean;
  readonly bodyPreview: string | null;
  readonly modifiedAt: string | null;
  readonly attendees: readonly TeamsAttendee[];
};

type TeamsFolderConversation = {
  readonly conversationId: string;
  readonly addedAt: string | null;
};

export type TeamsFolder = {
  readonly id: string;
  readonly name: string | null;
  readonly folderType: string | null;
  readonly sortType: string | null;
  readonly emoji: string | null;
  readonly isHidden: boolean | null;
  readonly isDeleted: boolean | null;
  readonly createdAt: string | null;
  readonly conversations: readonly TeamsFolderConversation[];
};

export type TeamsSavedMessage = {
  // The client feed that records it: 48:saved, or 48:starred from before
  // Teams named it saved.
  readonly feed: string;
  readonly id: string;
  readonly conversationId: string | null;
  readonly threadId: string | null;
  readonly messageId: string | null;
  readonly savedAt: string;
};

export type TeamsInstalledApp = {
  // Where the app is installed: user, chat or team.
  readonly scope: string;
  readonly scopeId: string;
  readonly appId: string;
  readonly state: string;
  readonly version: string | null;
  readonly installedBy: string | null;
  readonly name: string | null;
  readonly developerName: string | null;
};

type TeamsSearch = {
  readonly id: string;
  readonly query: string;
  readonly searchedAt: string | null;
};

export type TeamsClient = {
  readonly account: TeamsAccount;
  readonly conversations: readonly TeamsConversation[];
  // Every chat and channel message the client holds, the feeds below apart.
  readonly messages: readonly TeamsMessage[];
  readonly callLogs: readonly TeamsCallLog[];
  readonly activities: readonly TeamsActivity[];
  readonly people: readonly TeamsPerson[];
  readonly meetings: readonly TeamsMeeting[];
  readonly folders: readonly TeamsFolder[];
  readonly savedMessages: readonly TeamsSavedMessage[];
  readonly installedApps: readonly TeamsInstalledApp[];
  readonly searches: readonly TeamsSearch[];
  // Whether the client holds this part of a conversation's or a channel
  // thread's history: a message there that the client no longer holds was
  // deleted, not dropped from its cache.
  holds(conversationId: string, threadId: string, messageId: string): boolean;
  // Whether the client has loaded which apps are installed for this user,
  // chat or team: an app it no longer lists there was uninstalled.
  holdsApps(scope: string, scopeId: string): boolean;
};
