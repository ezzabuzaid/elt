import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtempDisposable, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  type IndexedDBWrite,
  IndexedDBWriter,
} from '@workspace/codec-chromium-indexeddb/test';
import {
  Connection,
  Copy,
  type CopyResult,
  Pipeline,
  PipelineError,
  type Stream,
  type Target,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import {
  TeamsFormatError,
  TeamsStore,
  TeamsUnavailableError,
} from '@workspace/sdk-microsoft-teams';

import { TeamsSource } from './teams-source.ts';

// The Teams app keeps what its web client loads in Chromium's IndexedDB for
// teams.microsoft.com: one database per manager of the client and per
// signed-in account, with records in the client's own shapes. The fixtures
// below lay that store out as the app does, in the shapes read from a live
// store, so the store under test is the upstream's own format.

const tenant = '7c1b6a4e-0d2f-4a8e-9b3c-5e6f7a8b9c0d';
const user = '3f2e1d0c-4b5a-4968-8776-a5b4c3d2e1f0';
const me = `8:orgid:${user}`;
const ada = '8:orgid:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const bot = '28:bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const chat = '19:ada-chat@thread.v2';
const team = '19:design-general@thread.tacv2';
const channel = '19:design-reviews@thread.tacv2';
const notes = '48:notes';
const leveldb = 'IndexedDB/https_teams.microsoft.com_0.indexeddb.leveldb';

// Teams names a message by when the service received it, in milliseconds.
const id = (instant: string) => String(Date.parse(instant));
const ms = (instant: string) => Date.parse(instant);

const ids = {
  hello: id('2026-09-01T09:00:00.000Z'),
  reply: id('2026-09-02T10:00:00.000Z'),
  deleted: id('2026-09-03T11:00:00.000Z'),
  latest: id('2026-09-25T08:30:00.000Z'),
  post: id('2026-09-10T12:00:00.000Z'),
  answer: id('2026-09-10T12:30:00.000Z'),
  note: id('2026-09-15T07:00:00.000Z'),
  call: id('2026-09-12T15:00:00.000Z'),
  groupCall: id('2026-09-13T16:00:00.000Z'),
  recording: id('2026-09-13T16:05:00.000Z'),
  mention: id('2026-09-01T09:00:02.000Z'),
  reaction: id('2026-09-01T09:10:00.000Z'),
  starred: id('2026-09-11T08:00:00.000Z'),
  saved: id('2026-09-20T08:00:00.000Z'),
};

// A message as the reply chain cache holds it.
function message({
  conversationId,
  id: messageId,
  threadId = messageId,
  creator = ada,
  name = 'Ada Lovelace',
  content = '<p>hi</p>',
  messageType = 'RichText/Html',
  fromUser = creator === me,
  properties = {},
}: {
  readonly conversationId: string;
  readonly id: string;
  readonly threadId?: string;
  readonly creator?: string;
  readonly name?: string;
  readonly content?: string | null;
  readonly messageType?: string;
  readonly fromUser?: boolean;
  readonly properties?: Record<string, unknown>;
}) {
  const withLanguage: Entry = {
    languageStamp: 'languages=en:100;',
    ...properties,
  };
  return {
    id: messageId,
    dedupeKey: `${conversationId}_${messageId}`,
    conversationId,
    parentMessageId: threadId,
    clientMessageId: `9${messageId}`,
    sequenceId: 1,
    version: messageId,
    searchKey: `${conversationId}_${messageId}`,
    type: 'Message',
    contentType: 'Text',
    activityType: '',
    messageType,
    threadType: '',
    clientArrivalTime: Number(messageId) + 40,
    originalArrivalTime: Number(messageId),
    prioritizeImDisplayName: false,
    imDisplayName: name,
    creator,
    content,
    contentHash: '0',
    source: 1,
    properties: withLanguage,
    isSanitized: true,
    state: 1,
    isSentByCurrentUser: fromUser,
    sendPipelineStatus: null,
  };
}

type Message = ReturnType<typeof message>;

// A reply chain: the messages of one thread, keyed by sender and client id.
function chain(messages: readonly Message[]) {
  const [first] = messages;
  if (first === undefined) throw new Error('a chain holds a message');
  return {
    conversationId: first.conversationId,
    replyChainId: first.parentMessageId,
    latestDeliveryTime: Math.max(...messages.map((m) => m.originalArrivalTime)),
    originalArrivalTime: first.originalArrivalTime,
    parentMessageVersion: first.originalArrivalTime,
    messageMap: Object.fromEntries(
      messages.map((m) => [`${m.creator}_${m.clientMessageId}`, m]),
    ),
  };
}

// The span of a conversation's history the client holds, as a sync state.
function held(syncId: string, start: string, end: string) {
  return {
    id: syncId,
    isChannel: false,
    chatServiceStartOfSyncWindow: ms(start),
    chatServiceEndOfSyncWindow: ms(end),
    _isSyncedToStartOfTime: false,
    isGapDetected: false,
    isMessageStale: false,
    lastSyncTime: ms(end),
  };
}

function activity(
  feed: string,
  messageId: string,
  fields: Record<string, unknown>,
) {
  return message({
    conversationId: feed,
    id: messageId,
    creator: '48:orgid',
    name: '',
    messageType: 'Text',
    properties: { activity: fields },
  });
}

type Entry = Record<string, unknown>;
type Chain = ReturnType<typeof chain>;

type Account = {
  readonly tenant: string;
  readonly user: string;
  // The app language the web client named its databases with: en-us unless
  // a test says otherwise.
  readonly locale?: string;
  readonly domains: readonly string[];
  readonly conversations: readonly Entry[];
  readonly chains: readonly Chain[];
  readonly saved: readonly Chain[];
  readonly windows: readonly Entry[];
  readonly feedItems: readonly Entry[];
  readonly profiles: readonly Entry[];
  readonly meetings: readonly Entry[];
  readonly folders: readonly Entry[];
  readonly apps: {
    readonly user: Entry;
    readonly team: Entry | null;
    readonly defaults: Entry;
    // Each manager keeps the definitions of the apps its scopes install.
    readonly userDefinitions: readonly Entry[];
    readonly teamDefinitions: readonly Entry[];
  };
  readonly searches: readonly Entry[];
};

// What one signed-in account's web client keeps, by what each manager
// stores. Tests change a copy of it and save it again.
function account(): Account {
  const hello = message({
    conversationId: chat,
    id: ids.hello,
    content:
      '<p>Hello <span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="0">Ezz</span>, the spec is attached</p>',
    properties: {
      edittime: ms('2026-09-01T09:05:00.000Z'),
      importance: '',
      subject: '',
      mentions: JSON.stringify([
        {
          '@type': 'http://schema.skype.com/Mention',
          itemid: 0,
          mri: me,
          mentionType: 'person',
          displayName: 'Ezz',
        },
      ]),
      // Teams keeps some link previews' line breaks raw inside the JSON.
      links:
        '[{"@type":"http://schema.skype.com/HyperLink","itemid":"0","url":"https://example.com/spec","previewenabled":true,"preview":{"previewurl":"https://example.com/spec.png","title":"The spec\nversion 2","description":"What we build"}}]',
      files: JSON.stringify([
        {
          '@type': 'http://schema.skype.com/File',
          version: 2,
          id: 'file-1',
          itemid: 'file-1',
          fileName: 'spec.pdf',
          fileType: 'pdf',
          title: 'spec.pdf',
          type: 'pdf',
          objectUrl: 'https://contoso-my.sharepoint.com/personal/ada/spec.pdf',
          fileInfo: {
            itemId: null,
            fileUrl: 'https://contoso-my.sharepoint.com/personal/ada/spec.pdf',
            siteUrl: 'https://contoso-my.sharepoint.com/personal/ada/',
            serverRelativeUrl: '/personal/ada/spec.pdf',
            shareUrl: 'https://contoso-my.sharepoint.com/:b:/g/personal/ada/s',
            shareId: 's',
          },
          fileChicletState: { serviceName: 'p2p', state: 'active' },
        },
      ]),
      cards: '[]',
      emotions: [
        {
          key: 'like',
          users: [
            {
              mri: me,
              time: ms('2026-09-01T09:10:00.000Z'),
              value: String(ms('2026-09-01T09:10:00.000Z')),
            },
          ],
        },
      ],
      pinned: JSON.stringify({
        creatorId: ada,
        pinnedTime: ms('2026-09-04T10:00:00.000Z'),
      }),
    },
  });
  const reply = message({
    conversationId: chat,
    id: ids.reply,
    creator: me,
    name: 'Ezz',
    content: '<p>Looks right</p>',
    properties: {
      qtdMsgs: [
        {
          messageId: Number(ids.hello),
          sender: ada,
          time: Number(ids.hello),
          message: null,
          validationResult: 'Valid',
          sharedRefId: null,
          replyChainId: null,
        },
      ],
      cards: JSON.stringify([
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: { type: 'AdaptiveCard', version: '1.5' },
        },
      ]),
      pinned: JSON.stringify({ creatorId: '', pinnedTime: 0 }),
    },
  });
  // A deleted message keeps its place, with no content and the time Teams
  // deleted it as digits.
  const deleted = message({
    conversationId: chat,
    id: ids.deleted,
    content: null,
    properties: {
      deletetime: String(ms('2026-09-03T11:05:00.000Z')),
      hardDeleteTime: ms('2026-09-03T11:05:00.000Z'),
      hardDeleteReason: 'ThreadServiceDeleteMessage',
    },
  });
  const post = message({
    conversationId: channel,
    id: ids.post,
    content: '<p>The plan for the release</p>',
    properties: { subject: 'Release plan', importance: 'high' },
  });
  const answer = message({
    conversationId: channel,
    id: ids.answer,
    threadId: ids.post,
    creator: me,
    name: 'Ezz',
    content: '<p>Agreed</p>',
  });
  const note = message({
    conversationId: notes,
    id: ids.note,
    creator: me,
    name: 'Ezz',
    content: '<p>remember the plan</p>',
  });
  const callLog = (logId: string, log: Record<string, unknown>) =>
    message({
      conversationId: '48:calllogs',
      id: logId,
      creator: me,
      name: '',
      messageType: 'Text',
      properties: {
        'call-log': JSON.stringify(log),
        s2spartnername: 'concore_gvc',
      },
    });
  return {
    tenant,
    user,
    domains: ['contoso.com', 'contoso.onmicrosoft.com'],
    conversations: [
      {
        id: chat,
        type: 'Chat',
        teamId: chat,
        lastMessageTimeUtc: ms('2026-09-25T08:30:00.000Z'),
        properties: {
          consumptionhorizon: `${ms('2026-09-24T18:00:00.000Z')};${ms('2026-09-24T18:00:01.000Z')};4467890123456789012`,
          favorite: 'false',
          ispinned: true,
          isDeleted: false,
        },
        threadProperties: {
          topic: null,
          creator: ada,
          createdat: String(ms('2026-08-20T10:00:00.000Z')),
          isRead: false,
          hidden: false,
          threadType: 'chat',
          tenantid: tenant,
          pinnedItems: JSON.stringify([
            { itemType: 'Message', itemId: ids.hello },
          ]),
        },
        chatTitle: {
          shortTitle: 'Ada',
          longTitle: 'Ada Lovelace',
          conversationMembersTotalCount: 3,
        },
        members: [
          { id: me, role: 'Admin', isReader: false },
          {
            id: ada,
            role: 'Admin',
            isReader: false,
            shareHistoryTime: ms('2026-08-20T10:00:00.000Z'),
          },
        ],
        botMembers: [{ id: bot, role: 'User', isReader: false }],
        // The conversation's own copy of its pins, behind its thread's.
        pinnedItems: [],
        // The newest message, which no cached chain holds, and the newest
        // that is not a change to the chat, which the chain holds.
        lastMessage: {
          id: ids.latest,
          messagetype: 'Text',
          contenttype: 'text',
          content: 'see you tomorrow',
          originalarrivaltime: '2026-09-25T08:30:00.000Z',
          composetime: '2026-09-25T08:29:59.000Z',
          fromUserId: ada,
          imdisplayname: 'Ada Lovelace',
          conversationLink: `https://notifications.skype.net/v1/users/ME/conversations/${chat}`,
          properties: {},
          type: 'Message',
        },
        lastNonTMMessage: {
          id: ids.hello,
          messagetype: 'RichText/Html',
          contenttype: 'Text',
          content: 'stale copy of hello',
          originalarrivaltime: '2026-09-01T09:00:00.000Z',
          fromUserId: ada,
          imdisplayname: 'Ada Lovelace',
          conversationLink: `https://notifications.skype.net/v1/users/ME/conversations/${chat}`,
          properties: {},
        },
      },
      {
        id: team,
        type: 'Space',
        teamId: team,
        lastMessageTimeUtc: ms('2026-09-10T12:30:00.000Z'),
        properties: { consumptionhorizon: '0;0;0' },
        threadProperties: {
          topic: 'General',
          spaceThreadTopic: 'Design Team',
          creator: ada,
          createdat: ms('2026-01-05T09:00:00.000Z'),
          visibility: 'private',
          threadType: 'space',
          tenantid: tenant,
        },
        rosterSummary: { memberCount: 12, botCount: 0, readerCount: 0 },
      },
      {
        id: channel,
        type: 'Topic',
        teamId: team,
        lastMessageTimeUtc: ms('2026-09-10T12:30:00.000Z'),
        properties: { favorite: 'true', consumptionhorizon: '' },
        threadProperties: {
          topic: 'design-reviews',
          topicThreadTopic: 'design-reviews',
          description: 'Where designs are reviewed',
          createdat: null,
          isdeleted: 'false',
          threadSubType: 'PrivateChannel',
          threadType: 'topic',
          tenantid: tenant,
        },
        // A channel's last message names its thread in its link.
        lastMessage: {
          id: ids.answer,
          messagetype: 'RichText/Html',
          contenttype: 'Text',
          content: '<p>Agreed</p>',
          originalarrivaltime: '2026-09-10T12:30:00.000Z',
          fromUserId: me,
          imdisplayname: 'Ezz',
          conversationLink: `https://notifications.skype.net/v1/users/ME/conversations/${channel};messageid=${ids.post}`,
          properties: {},
        },
      },
      {
        id: notes,
        type: 'StreamOfNotes',
        lastMessageTimeUtc: ms('2026-09-15T07:00:00.000Z'),
        properties: {},
        threadProperties: { tenantid: tenant },
      },
      {
        // A Viva Engage community keeps a placeholder for a post Engage
        // holds: no type, sender or content.
        id: '19:eyJfdHlwZSI6Ikdyb3VwIn0@EngageCommunity',
        type: 'EngageCommunity',
        lastMessageTimeUtc: ms('2026-09-18T10:00:00.000Z'),
        properties: {},
        threadProperties: { topic: 'All Company', tenantid: tenant },
        lastMessage: {
          id: 'eyJfdHlwZSI6IlRocmVhZCIsImlkIjoiMTIzIn0',
          contenttype: '',
          contentHash: '0',
          from: 'worker/undefined',
          fromUserId: '',
          originalarrivaltime: '2026-09-18T10:00:00.000Z',
          conversationLink: 'https://example.com/engage',
          properties: {},
        },
      },
    ],
    chains: [
      chain([hello]),
      chain([reply]),
      chain([deleted]),
      chain([post, answer]),
      chain([note]),
      chain([
        callLog(ids.call, {
          startTime: '2026-09-12T14:35:04.9634166Z',
          connectTime: '2026-09-12T14:35:07.70682Z',
          endTime: '2026-09-12T14:55:25.0540543Z',
          callDirection: 'incoming',
          callType: 'twoParty',
          callState: 'accepted',
          userParticipantId: me,
          originator: ada,
          target: me,
          originatorParticipant: {
            id: ada,
            type: 'default',
            displayName: 'Ada Lovelace',
            applicationType: null,
          },
          targetParticipant: {
            id: me,
            type: 'default',
            displayName: null,
            applicationType: null,
          },
          callId: 'call-1',
          callAttributes: null,
          forwardingInfo: null,
          transferInfo: null,
          participants: null,
          participantList: null,
          threadId: null,
          sessionType: 'default',
          messageId: null,
        }),
      ]),
      chain([
        callLog(ids.groupCall, {
          startTime: '2026-09-13T15:00:00Z',
          connectTime: null,
          endTime: '2026-09-13T15:01:00.5Z',
          callDirection: 'incoming',
          callType: 'multiParty',
          callState: 'missed',
          originator: ada,
          target: null,
          originatorParticipant: {
            id: ada,
            type: 'default',
            displayName: 'Ada Lovelace',
            applicationType: null,
          },
          targetParticipant: null,
          callId: 'call-2',
          forwardingInfo: {
            forwardingType: 'unanswered',
            forwardingDestinationType: 'voicemail',
            acceptedBy: { id: me, type: 'voicemail', displayName: null },
          },
          participants: [ada, me],
          participantList: [
            { id: ada, type: 'default', displayName: null, tenantId: tenant },
            { id: me, type: 'default', displayName: null, tenantId: tenant },
          ],
          threadId: '19:meeting_abc@thread.v2',
          messageId: '1789311600000',
          sessionType: 'default',
        }),
      ]),
      // A recording notice in the call log describes no call: it stays a
      // message.
      chain([
        message({
          conversationId: '48:calllogs',
          id: ids.recording,
          creator: me,
          name: '',
          messageType: 'RichText/Media_CallLogRecording',
          content: '<URIObject type="Video.2/CallRecording.1"></URIObject>',
        }),
      ]),
      chain([
        activity('48:notifications', ids.mention, {
          activityType: 'mentionInChat',
          activitySubtype: 'mention',
          activityTimestamp: '2026-09-01T09:00:01.5Z',
          activityId: 2867104311941160,
          sourceThreadId: chat,
          sourceMessageId: Number(ids.hello),
          sourceReplyChainId: Number(ids.hello),
          sourceUserId: ada,
          sourceUserImDisplayName: 'Ada Lovelace',
          sourceThreadTopic: 'Ada Lovelace',
          messagePreview: 'Hello Ezz, the spec is attached',
          messagePreviewTemplateOption: 'hasText',
          targetUserId: me,
        }),
      ]),
      // Reactions to the user's messages carry no activity time.
      chain([
        activity('48:annotations', ids.reaction, {
          activityType: 'reactionInChat',
          activitySubtype: 'like',
          activityId: 2867104311941161,
          sourceThreadId: chat,
          sourceMessageId: Number(ids.reply),
          sourceReplyChainId: Number(ids.reply),
          sourceUserId: ada,
          sourceUserImDisplayName: 'Ada Lovelace',
          messagePreview: 'Looks right',
        }),
      ]),
      chain([
        message({
          conversationId: '48:starred',
          id: ids.starred,
          creator: me,
          name: '',
          content: '<p>The plan for the release</p>',
          properties: {
            starred: {
              mri: ada,
              imdisplayname: 'Ada Lovelace',
              messageId: ids.post,
              parentMessageId: ids.post,
              threadId: channel,
              originalComposeTime: '2026-09-10T12:00:00.00Z',
            },
          },
        }),
      ]),
    ],
    saved: [
      chain([
        activity('48:saved', ids.saved, {
          activityType: 'savedMessage',
          activitySubtype: 'saved',
          activityTimestamp: '2026-09-20T08:00:00.12Z',
          activityId: 2867104311941162,
          sourceThreadId: chat,
          sourceMessageId: Number(ids.hello),
          sourceReplyChainId: Number(ids.hello),
          sourceUserId: ada,
          sourceUserImDisplayName: 'Ada Lovelace',
          messagePreview: 'Hello Ezz',
        }),
      ]),
    ],
    windows: [
      held(chat, '2026-08-20T00:00:00Z', '2026-09-24T00:00:00Z'),
      held(channel, '2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z'),
      held(
        `${channel};messageid=${ids.post}`,
        '2026-09-10T12:00:00Z',
        '2026-09-30T00:00:00Z',
      ),
      held(notes, '2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z'),
      ...[
        '48:calllogs',
        '48:notifications',
        '48:annotations',
        '48:saved',
        '48:starred',
      ].map((feed) =>
        held(feed, '2026-08-01T00:00:00Z', '2026-09-30T00:00:00Z'),
      ),
    ],
    feedItems: [
      {
        activityId: '2867104311941160',
        activityType: 'mention',
        activitySubtype: 'mentionInChat',
        sourceThreadId: chat,
        sourceMessageId: ids.hello,
        timestamp: ms('2026-09-01T09:00:01.500Z'),
        isRead: true,
        messageId: ids.mention,
        sourceReplyChainId: ids.hello,
      },
    ],
    profiles: [
      {
        mri: ada,
        objectId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
        type: 'ADUser',
        displayName: 'Ada Lovelace',
        givenName: 'Ada',
        surname: 'Lovelace',
        email: 'ada@contoso.com',
        userPrincipalName: 'ada@contoso.com',
        jobTitle: 'Engineer',
        department: 'R&D',
        companyName: 'Contoso',
        physicalDeliveryOfficeName: 'London',
        userLocation: 'UK-Hybrid',
        tenantName: 'Contoso',
        userType: 'Member',
        $$updated: ms('2026-10-01T00:00:00.000Z'),
        $$requestCount: 0,
      },
      {
        mri: bot,
        objectId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
        type: 'BOT',
        displayName: 'Planner',
        givenName: '',
        surname: '',
        userPrincipalName: '',
        $$updated: ms('2026-10-01T00:00:00.000Z'),
        $$requestCount: 0,
      },
    ],
    meetings: [
      {
        objectId: 'AAMkAD-occurrence-1',
        iCalUID: '040000008200E00074C5B7101A82E008',
        seriesMasterId: 'AAMkAD-series-1',
        eventType: 'Occurrence',
        subject: 'Design review',
        startTime: new Date('2026-10-14T13:00:00.000Z'),
        endTime: new Date('2026-10-14T13:45:00.000Z'),
        eventTimeZone: 'GmtSt',
        utcOffset: 60,
        location: 'Microsoft Teams Meeting',
        organizerName: 'Ada Lovelace',
        organizerAddress: 'ada@contoso.com',
        isOnlineMeeting: true,
        skypeTeamsMeetingUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
        skypeTeamsDataObject: {
          cid: '19:meeting_abc@thread.v2',
          private: true,
          type: 'Scheduled',
        },
        myResponseType: 'Tentative',
        showAs: 'Tentative',
        bodyPreview: 'Agenda: the spec',
        lastModifiedTime: '2026-10-05T11:34:55-04:00',
        categories: [],
        attendees: [
          {
            status: { response: 'Accepted' },
            type: 'Required',
            role: 'User',
            address: 'ada@contoso.com',
            name: 'Ada Lovelace',
          },
        ],
      },
    ],
    folders: [
      {
        id: 'folder-1',
        name: 'Projects',
        sortType: 'MostRecent',
        isExpanded: true,
        folderType: 'UserCreated',
        isDeleted: false,
        emojiCode: '1f680',
        createdTime: ms('2026-07-01T09:00:00.000Z'),
        conversations: [
          {
            id: chat,
            createdTime: ms('2026-07-02T09:00:00.000Z'),
            lastUpdatedTime: ms('2026-07-02T09:00:00.000Z'),
            threadType: 'chat',
          },
        ],
      },
    ],
    apps: {
      user: {
        cacheKey: `Personal_general_en-us_${user}`,
        appEntitlementkey: user,
        appEntitlements: [
          { id: 'app-planner', state: 'InstalledAndPermanent' },
          { id: 'app-offer', state: 'PreConsented' },
        ],
      },
      team: {
        cacheKey: `Team_general_en-us_${team}`,
        appEntitlementkey: team,
        appEntitlements: [
          {
            id: 'app-wiki',
            state: 'Installed',
            installedVersion: '2.1.0',
            installedBy: ada,
          },
          { id: 'app-store', state: 'NotInstalled' },
        ],
      },
      // The tenant's defaults for every group chat: not an installation.
      defaults: {
        cacheKey: 'GroupChat_general_en-us_default',
        appEntitlementkey: 'default',
        appEntitlements: [{ id: 'app-planner', state: 'Installed' }],
      },
      userDefinitions: [
        {
          cacheKey: 'app-planner_1.0.0',
          appId: 'app-planner',
          item: {
            id: 'app-planner',
            name: 'Planner',
            developerName: 'Microsoft',
            version: '1.0.0',
          },
          userLocale: 'en-us',
        },
      ],
      teamDefinitions: [
        {
          cacheKey: 'app-wiki_2.1.0',
          appId: 'app-wiki',
          item: {
            id: 'app-wiki',
            name: 'Wiki',
            developerName: 'Contoso',
            version: '2.1.0',
          },
          userLocale: 'en-us',
        },
      ],
    },
    searches: [
      {
        entityType: 'SEARCH',
        autoSuggestEntity: { searchQuery: 'release plan' },
        lastClickedTime: ms('2026-09-21T10:00:00.000Z'),
        uniqueId: 'search-1',
      },
    ],
  };
}

// Where each manager's database goes, named as the web client names it: most
// <tenant>:<user>, the folder manager's with the user's Teams ID, and the
// search history's the other way round.
function databaseName(manager: string, state: Account): string {
  const ids =
    manager === 'conversation-folder-manager'
      ? `${state.tenant}:8:orgid:${state.user}`
      : manager === 'search-history-manager'
        ? `${state.user}:${state.tenant}`
        : `${state.tenant}:${state.user}`;
  return `Teams:${manager}:react-web-client:${ids}:${state.locale ?? 'en-us'}`;
}

function writes(state: Account): IndexedDBWrite[] {
  const put = (
    manager: string,
    objectStore: string,
    key: string,
    value: unknown,
  ): IndexedDBWrite => ({
    database: databaseName(manager, state),
    objectStore,
    key,
    value,
  });
  const keyed = <T>(
    manager: string,
    objectStore: string,
    records: readonly T[],
    key: (record: T) => string,
  ) => records.map((record) => put(manager, objectStore, key(record), record));
  return [
    put('tenant-manager', 'tenant', 'domains', {
      category: 'domains',
      $$updated: ms('2026-10-01T00:00:00.000Z'),
      value: state.domains,
    }),
    ...keyed(
      'conversation-manager',
      'conversations',
      state.conversations,
      (c) => String(c.id),
    ),
    ...keyed(
      'replychain-manager',
      'replychains',
      state.chains,
      (c) => `${c.conversationId}/${c.replyChainId}`,
    ),
    ...keyed(
      'streams-replychain-manager',
      'saved',
      state.saved,
      (c) => c.replyChainId,
    ),
    ...keyed('syncstate-manager', 'syncstates', state.windows, (s) =>
      String(s.id),
    ),
    ...keyed('activity-manager', 'feed-items', state.feedItems, (f) =>
      String(f.activityId),
    ),
    ...keyed('profiles', 'profiles', state.profiles, (p) => String(p.mri)),
    ...keyed('calendar', 'calendar', state.meetings, (m) => String(m.objectId)),
    ...keyed('conversation-folder-manager', 'folders', state.folders, (f) =>
      String(f.id),
    ),
    put(
      'user-installed-apps-manager',
      'user-app-entitlements',
      String(state.apps.user.cacheKey),
      state.apps.user,
    ),
    ...state.apps.userDefinitions.map((d) =>
      put(
        'user-installed-apps-manager',
        'user-app-definitions',
        String(d.cacheKey),
        d,
      ),
    ),
    ...(state.apps.team === null
      ? []
      : [
          put(
            'team-installed-apps-manager',
            'app-entitlements',
            String(state.apps.team.cacheKey),
            state.apps.team,
          ),
        ]),
    ...state.apps.teamDefinitions.map((d) =>
      put(
        'team-installed-apps-manager',
        'app-definitions',
        String(d.cacheKey),
        d,
      ),
    ),
    put(
      'chat-installed-apps-manager',
      'app-entitlements',
      String(state.apps.defaults.cacheKey),
      state.apps.defaults,
    ),
    ...keyed('search-history-manager', 'searchhistory', state.searches, (s) =>
      String(s.uniqueId),
    ),
  ];
}

// Writes the Teams app's store under a temporary folder, as the app leaves it
// once its web client has saved these accounts.
class TeamsApp {
  readonly directory: string;
  readonly #indexedDB: IndexedDBWriter;

  constructor(root: string) {
    this.directory = join(root, 'WV2Profile_tfw');
    this.#indexedDB = new IndexedDBWriter(join(this.directory, leveldb));
  }

  async save(...accounts: readonly Account[]): Promise<void> {
    await this.write(accounts.flatMap(writes));
  }

  async write(records: readonly IndexedDBWrite[]): Promise<void> {
    await this.#indexedDB.save(records);
  }
}

// The account with one conversation as change makes it.
function changing(
  state: Account,
  conversationId: string,
  change: (conversation: Entry) => Entry,
): Account {
  return {
    ...state,
    conversations: state.conversations.map((conversation) =>
      conversation.id === conversationId ? change(conversation) : conversation,
    ),
  };
}

// The account without the reply chain of this thread.
function dropping(state: Account, conversationId: string, threadId: string) {
  return {
    ...state,
    chains: state.chains.filter(
      (c) =>
        !(c.conversationId === conversationId && c.replyChainId === threadId),
    ),
  };
}

// The account holding this span of a conversation's history instead, or
// none when start is null.
function holding(
  state: Account,
  syncId: string,
  start: string | null,
  end = '2026-09-30T00:00:00Z',
): Account {
  return {
    ...state,
    windows: [
      ...state.windows.filter((window) => window.id !== syncId),
      ...(start === null ? [] : [held(syncId, start, end)]),
    ],
  };
}

function rows(path: string, sql: string) {
  using db = new DatabaseSync(path, { readOnly: true });
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

// A stream's rows as a consumer reads them: every column but the time the
// destination loaded the row.
function table(path: string, name: string, order: string) {
  const columns = rows(path, `SELECT name FROM pragma_table_info('${name}')`)
    .map((column) => String(column.name))
    .filter((column) => column !== 'loaded_at');
  return rows(
    path,
    `SELECT ${columns.map((column) => `"${column}"`).join(', ')} FROM "${name}" ORDER BY ${order}`,
  );
}

async function pipeline(source: TeamsSource, directory: string) {
  const destination = new SQLiteDestination({
    path: join(directory, 'out.sqlite'),
  });
  const { streams } = await source.discover();
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  return new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(directory, 'state.sqlite'),
        }),
        steps: streams.map(
          (stream: Stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: stream.name,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  });
}

const counts = (results: readonly CopyResult<Target>[]) =>
  Object.fromEntries(
    results.map(({ copy, count, deleted }) => [
      copy.from.name,
      { count, deleted },
    ]),
  );

// Every stream writing nothing, as a run over an unchanged store does.
async function unchanged(source: TeamsSource) {
  const { streams } = await source.discover();
  return Object.fromEntries(
    streams.map(({ name }) => [name, { count: 0, deleted: 0 }]),
  );
}

async function scratch() {
  const dir = await mkdtempDisposable(join(tmpdir(), 'teams-'));
  return {
    dir,
    app: new TeamsApp(dir.path),
    out: join(dir.path, 'out.sqlite'),
  };
}

// Each kind of failure a run's copies reported, once.
function failureTypes(error: {
  readonly results: readonly {
    readonly failures: readonly { readonly failureType: string }[];
  }[];
}): string[] {
  return [
    ...new Set(
      error.results.flatMap(({ failures }) =>
        failures.map(({ failureType }) => failureType),
      ),
    ),
  ];
}

test('a store that stops being readable fails every stream, naming Full Disk Access, and keeps what loaded', async () => {
  const { dir, app, out } = await scratch();
  await using _ = dir;
  await app.save(account());
  const source = new TeamsSource(app.directory);
  const run = await pipeline(source, dir.path);
  await run.run();
  const { streams } = await source.discover();
  // chmod stands in for macOS withholding the app's container from a process
  // without Full Disk Access: both fail the read with EACCES or EPERM.
  await chmod(app.directory, 0o000);

  try {
    await assert.rejects(run.run(), (error) => {
      assert.ok(error instanceof PipelineError);
      assert.equal(error.errors.length, streams.length);
      for (const cause of error.errors) {
        assert.ok(cause instanceof TeamsUnavailableError);
        assert.match(cause.message, /Full Disk Access/);
      }
      assert.deepEqual(failureTypes(error), ['config']);
      return true;
    });
  } finally {
    await chmod(app.directory, 0o755);
  }

  assert.deepEqual(rows(out, 'SELECT count(*) AS n FROM messages'), [{ n: 8 }]);
  assert.deepEqual(counts(await run.run()), await unchanged(source));
});

test('a store in a shape this reader does not know, or that fails to read for another reason, fails every stream as the problem it is and keeps what loaded', async () => {
  const { dir, app, out } = await scratch();
  await using _ = dir;
  await app.save(account());
  const source = new TeamsSource(app.directory);
  const run = await pipeline(source, dir.path);
  await run.run();
  const { streams } = await source.discover();
  // A message with no conversation, which Teams has never written.
  await app.write(
    writes(account()).map((write) =>
      write.objectStore === 'replychains' &&
      write.key === `${chat}/${ids.hello}`
        ? {
            ...write,
            value: {
              conversationId: chat,
              replyChainId: ids.hello,
              messageMap: { lost: { id: ids.hello, messageType: 'Text' } },
            },
          }
        : write,
    ),
  );

  await assert.rejects(run.run(), (error) => {
    assert.ok(error instanceof PipelineError);
    assert.equal(error.errors.length, streams.length);
    for (const cause of error.errors) {
      assert.ok(cause instanceof TeamsFormatError);
      assert.match(
        cause.message,
        /replychains.*conversationId is not a non-empty string/,
      );
    }
    assert.deepEqual(failureTypes(error), ['system']);
    return true;
  });

  // A directory where the log should be: readable, but not a file.
  await app.save(account());
  const log = join(app.directory, leveldb, '000003.log');
  await rm(log);
  await mkdir(log);
  await assert.rejects(run.run(), (error) => {
    assert.ok(error instanceof PipelineError);
    for (const cause of error.errors) {
      assert.ok(!(cause instanceof TeamsUnavailableError));
      assert.equal(Reflect.get(cause, 'code'), 'EISDIR');
    }
    assert.deepEqual(failureTypes(error), ['system']);
    return true;
  });

  await rm(log, { recursive: true });
  await app.save(account());
  assert.deepEqual(rows(out, 'SELECT count(*) AS n FROM messages'), [{ n: 8 }]);
  assert.deepEqual(counts(await run.run()), await unchanged(source));
});

test('every stream loads what the Teams app keeps, as a consumer reads it, and a second run with no save writes nothing', async () => {
  const { dir, app, out } = await scratch();
  await using _ = dir;
  // The channel's newest reply, which no cached chain holds: the link it
  // carries names its thread.
  const later = id('2026-09-10T13:00:00.000Z');
  // The client lists its own feeds as conversations too; the newest entry of
  // its call log is a call, not a message.
  const withFeed = {
    ...account(),
    conversations: [
      ...account().conversations,
      {
        id: '48:calllogs',
        type: 'Conversation',
        lastMessageTimeUtc: ms('2026-09-13T16:05:00.000Z'),
        properties: {},
        threadProperties: {},
        lastMessage: {
          id: ids.call,
          messagetype: 'Text',
          contenttype: 'text',
          content: '',
          originalarrivaltime: '2026-09-12T15:00:00.000Z',
          fromUserId: me,
          conversationLink:
            'https://notifications.skype.net/v1/users/ME/conversations/48:calllogs',
          properties: {},
        },
      },
    ],
  };
  await app.save(
    changing(withFeed, channel, (conversation) => ({
      ...conversation,
      lastMessage: {
        id: later,
        messagetype: 'RichText/Html',
        contenttype: 'Text',
        content: '<p>Ship it</p>',
        originalarrivaltime: '2026-09-10T13:00:00.000Z',
        fromUserId: ada,
        imdisplayname: 'Ada Lovelace',
        conversationLink: `https://notifications.skype.net/v1/users/ME/conversations/${channel};messageid=${ids.post}`,
        properties: {},
      },
    })),
  );
  const source = new TeamsSource(app.directory);
  const run = await pipeline(source, dir.path);

  const first = counts(await run.run());

  const message = {
    accountId: user,
    subject: null,
    importance: null,
    editedAt: null,
    deletedAt: null,
    cardsJson: null,
    pinnedBy: null,
    pinnedAt: null,
  };
  const keyOf = (
    conversationId: string,
    threadId: string,
    messageId: string,
  ) => ({
    accountId: user,
    conversationId,
    threadId,
    messageId,
  });
  const expected = {
    accounts: [
      {
        id: user,
        tenantId: tenant,
        mri: me,
        tenantDomains: '["contoso.com","contoso.onmicrosoft.com"]',
      },
    ],
    conversations: [
      {
        accountId: user,
        id: chat,
        type: 'Chat',
        topic: null,
        title: 'Ada Lovelace',
        description: null,
        teamId: null,
        teamName: null,
        creatorId: ada,
        createdAt: '2026-08-20T10:00:00.000Z',
        lastMessageAt: '2026-09-25T08:30:00.000Z',
        lastReadAt: '2026-09-24T18:00:00.000Z',
        isRead: 0,
        isFavorite: 0,
        isPinned: 1,
        isHidden: 0,
        isDeleted: 0,
        visibility: null,
        subType: null,
        memberCount: 3,
      },
      {
        accountId: user,
        id: team,
        type: 'Space',
        topic: 'General',
        title: null,
        description: null,
        teamId: team,
        teamName: 'Design Team',
        creatorId: ada,
        createdAt: '2026-01-05T09:00:00.000Z',
        lastMessageAt: '2026-09-10T12:30:00.000Z',
        lastReadAt: null,
        isRead: null,
        isFavorite: null,
        isPinned: null,
        isHidden: null,
        isDeleted: null,
        visibility: 'private',
        subType: null,
        memberCount: 12,
      },
      {
        accountId: user,
        id: channel,
        type: 'Topic',
        topic: 'design-reviews',
        title: null,
        description: 'Where designs are reviewed',
        teamId: team,
        teamName: null,
        creatorId: null,
        createdAt: null,
        lastMessageAt: '2026-09-10T12:30:00.000Z',
        lastReadAt: null,
        isRead: null,
        isFavorite: 1,
        isPinned: null,
        isHidden: null,
        isDeleted: 0,
        visibility: null,
        subType: 'PrivateChannel',
        memberCount: null,
      },
      {
        accountId: user,
        id: '19:eyJfdHlwZSI6Ikdyb3VwIn0@EngageCommunity',
        type: 'EngageCommunity',
        topic: 'All Company',
        title: null,
        description: null,
        teamId: null,
        teamName: null,
        creatorId: null,
        createdAt: null,
        lastMessageAt: '2026-09-18T10:00:00.000Z',
        lastReadAt: null,
        isRead: null,
        isFavorite: null,
        isPinned: null,
        isHidden: null,
        isDeleted: null,
        visibility: null,
        subType: null,
        memberCount: null,
      },
      {
        accountId: user,
        id: '48:calllogs',
        type: 'Conversation',
        topic: null,
        title: null,
        description: null,
        teamId: null,
        teamName: null,
        creatorId: null,
        createdAt: null,
        lastMessageAt: '2026-09-13T16:05:00.000Z',
        lastReadAt: null,
        isRead: null,
        isFavorite: null,
        isPinned: null,
        isHidden: null,
        isDeleted: null,
        visibility: null,
        subType: null,
        memberCount: null,
      },
      {
        accountId: user,
        id: notes,
        type: 'StreamOfNotes',
        topic: null,
        title: null,
        description: null,
        teamId: null,
        teamName: null,
        creatorId: null,
        createdAt: null,
        lastMessageAt: '2026-09-15T07:00:00.000Z',
        lastReadAt: null,
        isRead: null,
        isFavorite: null,
        isPinned: null,
        isHidden: null,
        isDeleted: null,
        visibility: null,
        subType: null,
        memberCount: null,
      },
    ],
    conversationMembers: [
      {
        accountId: user,
        conversationId: chat,
        memberId: bot,
        role: 'User',
        isBot: 1,
        isReader: 0,
        shareHistoryAt: null,
      },
      {
        accountId: user,
        conversationId: chat,
        memberId: me,
        role: 'Admin',
        isBot: 0,
        isReader: 0,
        shareHistoryAt: null,
      },
      {
        accountId: user,
        conversationId: chat,
        memberId: ada,
        role: 'Admin',
        isBot: 0,
        isReader: 0,
        shareHistoryAt: '2026-08-20T10:00:00.000Z',
      },
    ],
    messages: [
      {
        ...message,
        conversationId: chat,
        threadId: ids.hello,
        id: ids.hello,
        sentAt: '2026-09-01T09:00:00.000Z',
        senderId: ada,
        senderName: 'Ada Lovelace',
        messageType: 'RichText/Html',
        contentType: 'Text',
        content:
          '<p>Hello <span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="0">Ezz</span>, the spec is attached</p>',
        editedAt: '2026-09-01T09:05:00.000Z',
        isFromUser: 0,
        pinnedBy: ada,
        pinnedAt: '2026-09-04T10:00:00.000Z',
      },
      {
        ...message,
        conversationId: chat,
        threadId: ids.reply,
        id: ids.reply,
        sentAt: '2026-09-02T10:00:00.000Z',
        senderId: me,
        senderName: 'Ezz',
        messageType: 'RichText/Html',
        contentType: 'Text',
        content: '<p>Looks right</p>',
        isFromUser: 1,
        cardsJson:
          '[{"contentType":"application/vnd.microsoft.card.adaptive","content":{"type":"AdaptiveCard","version":"1.5"}}]',
      },
      {
        ...message,
        conversationId: chat,
        threadId: ids.deleted,
        id: ids.deleted,
        sentAt: '2026-09-03T11:00:00.000Z',
        senderId: ada,
        senderName: 'Ada Lovelace',
        messageType: 'RichText/Html',
        contentType: 'Text',
        content: null,
        deletedAt: '2026-09-03T11:05:00.000Z',
        isFromUser: 0,
      },
      {
        ...message,
        conversationId: chat,
        threadId: ids.latest,
        id: ids.latest,
        sentAt: '2026-09-25T08:30:00.000Z',
        senderId: ada,
        senderName: 'Ada Lovelace',
        messageType: 'Text',
        contentType: 'text',
        content: 'see you tomorrow',
        isFromUser: null,
      },
      {
        ...message,
        conversationId: channel,
        threadId: ids.post,
        id: ids.post,
        sentAt: '2026-09-10T12:00:00.000Z',
        senderId: ada,
        senderName: 'Ada Lovelace',
        messageType: 'RichText/Html',
        contentType: 'Text',
        content: '<p>The plan for the release</p>',
        subject: 'Release plan',
        importance: 'high',
        isFromUser: 0,
      },
      {
        ...message,
        conversationId: channel,
        threadId: ids.post,
        id: ids.answer,
        sentAt: '2026-09-10T12:30:00.000Z',
        senderId: me,
        senderName: 'Ezz',
        messageType: 'RichText/Html',
        contentType: 'Text',
        content: '<p>Agreed</p>',
        isFromUser: 1,
      },
      {
        ...message,
        conversationId: channel,
        threadId: ids.post,
        id: later,
        sentAt: '2026-09-10T13:00:00.000Z',
        senderId: ada,
        senderName: 'Ada Lovelace',
        messageType: 'RichText/Html',
        contentType: 'Text',
        content: '<p>Ship it</p>',
        isFromUser: null,
      },
      {
        ...message,
        conversationId: '48:calllogs',
        threadId: ids.recording,
        id: ids.recording,
        sentAt: '2026-09-13T16:05:00.000Z',
        senderId: me,
        senderName: null,
        messageType: 'RichText/Media_CallLogRecording',
        contentType: 'Text',
        content: '<URIObject type="Video.2/CallRecording.1"></URIObject>',
        isFromUser: 1,
      },
      {
        ...message,
        conversationId: notes,
        threadId: ids.note,
        id: ids.note,
        sentAt: '2026-09-15T07:00:00.000Z',
        senderId: me,
        senderName: 'Ezz',
        messageType: 'RichText/Html',
        contentType: 'Text',
        content: '<p>remember the plan</p>',
        isFromUser: 1,
      },
    ],
    messageReactions: [
      {
        ...keyOf(chat, ids.hello, ids.hello),
        emoji: 'like',
        userId: me,
        reactedAt: '2026-09-01T09:10:00.000Z',
      },
    ],
    messageMentions: [
      {
        ...keyOf(chat, ids.hello, ids.hello),
        position: 0,
        mentionedId: me,
        kind: 'person',
        displayName: 'Ezz',
      },
    ],
    messageFiles: [
      {
        ...keyOf(chat, ids.hello, ids.hello),
        fileId: 'file-1',
        name: 'spec.pdf',
        fileType: 'pdf',
        title: 'spec.pdf',
        url: 'https://contoso-my.sharepoint.com/personal/ada/spec.pdf',
        siteUrl: 'https://contoso-my.sharepoint.com/personal/ada/',
        shareUrl: 'https://contoso-my.sharepoint.com/:b:/g/personal/ada/s',
        service: 'p2p',
      },
    ],
    messageLinks: [
      {
        ...keyOf(chat, ids.hello, ids.hello),
        position: 0,
        url: 'https://example.com/spec',
        title: 'The spec\nversion 2',
        description: 'What we build',
        previewUrl: 'https://example.com/spec.png',
      },
    ],
    messageQuotes: [
      {
        ...keyOf(chat, ids.reply, ids.reply),
        position: 0,
        quotedMessageId: ids.hello,
        quotedSenderId: ada,
        quotedSentAt: '2026-09-01T09:00:00.000Z',
        quotedThreadId: null,
      },
    ],
    pins: [
      {
        accountId: user,
        conversationId: chat,
        messageId: ids.hello,
        position: 0,
      },
    ],
    callLogs: [
      {
        accountId: user,
        id: ids.call,
        callId: 'call-1',
        startedAt: '2026-09-12T14:35:04.9634166Z',
        connectedAt: '2026-09-12T14:35:07.7068200Z',
        endedAt: '2026-09-12T14:55:25.0540543Z',
        direction: 'incoming',
        callType: 'twoParty',
        state: 'accepted',
        originatorId: ada,
        originatorName: 'Ada Lovelace',
        targetId: me,
        targetType: 'default',
        conversationId: null,
        messageId: null,
        forwardedTo: null,
      },
      {
        accountId: user,
        id: ids.groupCall,
        callId: 'call-2',
        startedAt: '2026-09-13T15:00:00.0000000Z',
        connectedAt: null,
        endedAt: '2026-09-13T15:01:00.5000000Z',
        direction: 'incoming',
        callType: 'multiParty',
        state: 'missed',
        originatorId: ada,
        originatorName: 'Ada Lovelace',
        targetId: null,
        targetType: null,
        conversationId: '19:meeting_abc@thread.v2',
        messageId: '1789311600000',
        forwardedTo: 'voicemail',
      },
    ],
    callParticipants: [
      {
        accountId: user,
        callLogId: ids.groupCall,
        participantId: me,
        type: 'default',
        tenantId: tenant,
      },
      {
        accountId: user,
        callLogId: ids.groupCall,
        participantId: ada,
        type: 'default',
        tenantId: tenant,
      },
    ],
    activities: [
      {
        accountId: user,
        feed: 'annotations',
        id: ids.reaction,
        activityId: '2867104311941161',
        type: 'reactionInChat',
        subtype: 'like',
        occurredAt: '2026-09-01T09:10:00.000Z',
        sourceConversationId: chat,
        sourceThreadId: ids.reply,
        sourceMessageId: ids.reply,
        sourceUserId: ada,
        sourceUserName: 'Ada Lovelace',
        sourceTopic: null,
        preview: 'Looks right',
        isRead: null,
      },
      {
        accountId: user,
        feed: 'notifications',
        id: ids.mention,
        activityId: '2867104311941160',
        type: 'mentionInChat',
        subtype: 'mention',
        occurredAt: '2026-09-01T09:00:01.500Z',
        sourceConversationId: chat,
        sourceThreadId: ids.hello,
        sourceMessageId: ids.hello,
        sourceUserId: ada,
        sourceUserName: 'Ada Lovelace',
        sourceTopic: 'Ada Lovelace',
        preview: 'Hello Ezz, the spec is attached',
        isRead: 1,
      },
    ],
    savedMessages: [
      {
        accountId: user,
        feed: 'saved',
        id: ids.saved,
        conversationId: chat,
        threadId: ids.hello,
        messageId: ids.hello,
        savedAt: '2026-09-20T08:00:00.120Z',
      },
      {
        accountId: user,
        feed: 'starred',
        id: ids.starred,
        conversationId: channel,
        threadId: ids.post,
        messageId: ids.post,
        savedAt: '2026-09-11T08:00:00.000Z',
      },
    ],
    people: [
      {
        accountId: user,
        mri: bot,
        objectId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
        type: 'BOT',
        displayName: 'Planner',
        givenName: null,
        surname: null,
        email: null,
        userPrincipalName: null,
        jobTitle: null,
        department: null,
        companyName: null,
        officeLocation: null,
        userLocation: null,
        tenantName: null,
        userType: null,
      },
      {
        accountId: user,
        mri: ada,
        objectId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
        type: 'ADUser',
        displayName: 'Ada Lovelace',
        givenName: 'Ada',
        surname: 'Lovelace',
        email: 'ada@contoso.com',
        userPrincipalName: 'ada@contoso.com',
        jobTitle: 'Engineer',
        department: 'R&D',
        companyName: 'Contoso',
        officeLocation: 'London',
        userLocation: 'UK-Hybrid',
        tenantName: 'Contoso',
        userType: 'Member',
      },
    ],
    meetings: [
      {
        accountId: user,
        id: 'AAMkAD-occurrence-1',
        iCalUid: '040000008200E00074C5B7101A82E008',
        seriesMasterId: 'AAMkAD-series-1',
        eventType: 'Occurrence',
        subject: 'Design review',
        startAt: '2026-10-14T13:00:00.000Z',
        endAt: '2026-10-14T13:45:00.000Z',
        timeZone: 'GmtSt',
        location: 'Microsoft Teams Meeting',
        organizerName: 'Ada Lovelace',
        organizerAddress: 'ada@contoso.com',
        isOnlineMeeting: 1,
        joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
        conversationId: '19:meeting_abc@thread.v2',
        myResponse: 'Tentative',
        showAs: 'Tentative',
        isCancelled: 0,
        bodyPreview: 'Agenda: the spec',
        modifiedAt: '2026-10-05T15:34:55.0000000Z',
      },
    ],
    meetingAttendees: [
      {
        accountId: user,
        meetingId: 'AAMkAD-occurrence-1',
        address: 'ada@contoso.com',
        name: 'Ada Lovelace',
        type: 'Required',
        role: 'User',
        response: 'Accepted',
      },
    ],
    folders: [
      {
        accountId: user,
        id: 'folder-1',
        name: 'Projects',
        folderType: 'UserCreated',
        sortType: 'MostRecent',
        emoji: '1f680',
        isHidden: null,
        isDeleted: 0,
        createdAt: '2026-07-01T09:00:00.000Z',
      },
    ],
    folderConversations: [
      {
        accountId: user,
        folderId: 'folder-1',
        conversationId: chat,
        addedAt: '2026-07-02T09:00:00.000Z',
      },
    ],
    installedApps: [
      {
        accountId: user,
        scope: 'team',
        scopeId: team,
        appId: 'app-wiki',
        state: 'Installed',
        version: '2.1.0',
        installedBy: ada,
        name: 'Wiki',
        developerName: 'Contoso',
      },
      {
        accountId: user,
        scope: 'user',
        scopeId: user,
        appId: 'app-planner',
        state: 'InstalledAndPermanent',
        version: null,
        installedBy: null,
        name: 'Planner',
        developerName: 'Microsoft',
      },
    ],
    searches: [
      {
        accountId: user,
        id: 'search-1',
        query: 'release plan',
        searchedAt: '2026-09-21T10:00:00.000Z',
      },
    ],
  };
  const order: Record<string, string> = {
    accounts: 'id',
    conversations: 'id',
    conversationMembers: 'conversationId, memberId',
    messages: 'conversationId, id',
    messageReactions: 'messageId, emoji, userId',
    messageMentions: 'messageId, position',
    messageFiles: 'messageId, fileId',
    messageLinks: 'messageId, position',
    messageQuotes: 'messageId, position',
    pins: 'conversationId, position',
    callLogs: 'id',
    callParticipants: 'callLogId, participantId',
    activities: 'feed, id',
    savedMessages: 'feed, id',
    people: 'mri',
    meetings: 'id',
    meetingAttendees: 'meetingId, address',
    folders: 'id',
    folderConversations: 'folderId, conversationId',
    installedApps: 'scope, scopeId, appId',
    searches: 'id',
  };
  const { streams } = await source.discover();
  assert.deepEqual(
    streams.map(({ name }) => name).sort(),
    Object.keys(expected).sort(),
  );
  for (const [name, loaded] of Object.entries(expected)) {
    assert.deepEqual(table(out, name, order[name] ?? 'rowid'), loaded, name);
    assert.deepEqual(first[name], { count: loaded.length, deleted: 0 }, name);
  }
  assert.deepEqual(counts(await run.run()), await unchanged(source));
});

test('a message or reaction gone from the history the app holds is deleted, and one the app pruned from its cache stays with its parts until the app holds that history again', async () => {
  const { dir, app, out } = await scratch();
  await using _ = dir;
  const followUp = message({
    conversationId: channel,
    id: id('2026-09-10T12:45:00.000Z'),
    threadId: ids.post,
    content: '<p>Shipping Friday</p>',
  });
  const base = {
    ...account(),
    chains: account().chains.map((c) =>
      c.conversationId === channel
        ? chain([...Object.values(c.messageMap), followUp])
        : c,
    ),
  };
  await app.save(base);
  const source = new TeamsSource(app.directory);
  const run = await pipeline(source, dir.path);
  await run.run();
  const messageIds = (conversationId: string) =>
    rows(
      out,
      `SELECT id FROM messages WHERE conversationId = '${conversationId}' ORDER BY id`,
    ).map(({ id }) => id);
  const nothing = { count: 0, deleted: 0 };

  // Ada takes back the like on hello, and the deleted message's place goes,
  // inside the span of the chat the app holds.
  const unliked = dropping(base, chat, ids.deleted);
  const [helloChain] = unliked.chains;
  if (helloChain === undefined) throw new Error('the fixture holds hello');
  const [hello] = Object.values(helloChain.messageMap);
  if (hello === undefined) throw new Error('the chain holds hello');
  const { emotions: _emotions, ...withoutLike } = hello.properties;
  const reacted = {
    ...unliked,
    chains: [
      chain([{ ...hello, properties: withoutLike }]),
      ...unliked.chains.slice(1),
    ],
  };
  await app.save(reacted);
  const removed = counts(await run.run());
  assert.deepEqual(removed.messages, { count: 0, deleted: 1 });
  assert.deepEqual(removed.messageReactions, { count: 0, deleted: 1 });
  assert.deepEqual(messageIds(chat), [ids.hello, ids.reply, ids.latest]);

  // The app prunes its cache: the span now starts after hello and the reply,
  // and their chains are gone. Nothing of theirs was deleted.
  const pruned = holding(
    changing(
      dropping(dropping(reacted, chat, ids.hello), chat, ids.reply),
      chat,
      ({ lastNonTMMessage: _last, ...conversation }) => conversation,
    ),
    chat,
    '2026-09-02T12:00:00Z',
    '2026-09-24T00:00:00Z',
  );
  await app.save(pruned);
  const afterPrune = counts(await run.run());
  assert.deepEqual(afterPrune, await unchanged(source));
  assert.deepEqual(messageIds(chat), [ids.hello, ids.reply, ids.latest]);
  assert.deepEqual(
    ['messageMentions', 'messageFiles', 'messageLinks', 'messageQuotes'].map(
      (name) => rows(out, `SELECT count(*) AS n FROM ${name}`)[0]?.n,
    ),
    [1, 1, 1, 1],
  );

  // A reply goes from a thread the app holds: it was deleted. The channel's
  // newest message named it, so that goes too.
  const keeping = (state: Account, kept: readonly string[]): Account =>
    changing(
      {
        ...state,
        chains: state.chains.map((c) =>
          c.conversationId === channel
            ? chain(
                Object.values(c.messageMap).filter(({ id }) =>
                  kept.includes(id),
                ),
              )
            : c,
        ),
      },
      channel,
      ({ lastMessage: _last, ...conversation }) => conversation,
    );
  const answered = keeping(pruned, [ids.post, followUp.id]);
  await app.save(answered);
  assert.deepEqual(counts(await run.run()).messages, { count: 0, deleted: 1 });
  assert.deepEqual(messageIds(channel), [ids.post, followUp.id]);

  // The follow-up goes once the app no longer holds its thread, though the
  // channel's own span covers its time: the app loads only a thread's latest
  // replies with the channel, so the follow-up stays.
  const unthreaded = holding(
    keeping(answered, [ids.post]),
    `${channel};messageid=${ids.post}`,
    null,
  );
  await app.save(unthreaded);
  assert.deepEqual(counts(await run.run()).messages, nothing);
  assert.deepEqual(messageIds(channel), [ids.post, followUp.id]);

  // The app loads the thread again, and the follow-up is not in it: it was
  // deleted while the app did not hold the thread, so it goes now.
  const rethreaded = holding(
    unthreaded,
    `${channel};messageid=${ids.post}`,
    '2026-09-10T12:00:00Z',
  );
  await app.save(rethreaded);
  assert.deepEqual(counts(await run.run()).messages, { count: 0, deleted: 1 });
  assert.deepEqual(messageIds(channel), [ids.post]);

  // The chat's newest message, later than the span the app loaded and in no
  // cached chain, gives way to a newer one: it left the chat's newest place,
  // not the chat, so it stays beside the new one.
  const newer = id('2026-09-26T08:00:00.000Z');
  await app.save(
    changing(rethreaded, chat, (conversation) => ({
      ...conversation,
      lastMessage: {
        id: newer,
        messagetype: 'Text',
        contenttype: 'text',
        content: 'on my way',
        originalarrivaltime: '2026-09-26T08:00:00.000Z',
        fromUserId: ada,
        imdisplayname: 'Ada Lovelace',
        conversationLink: `https://notifications.skype.net/v1/users/ME/conversations/${chat}`,
        properties: {},
      },
    })),
  );
  assert.deepEqual(counts(await run.run()).messages, { count: 1, deleted: 0 });
  assert.deepEqual(messageIds(chat), [ids.hello, ids.reply, ids.latest, newer]);
});

test('a second account loads beside the first without rewriting it, and an account signed out of keeps every row', async () => {
  const { dir, app, out } = await scratch();
  await using _ = dir;
  const first = account();
  // Another work account signed in to the app, in a chat with the same
  // conversation ids.
  const second: Account = {
    ...account(),
    tenant: '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a',
    user: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  };
  await app.save(first);
  const source = new TeamsSource(app.directory);
  const run = await pipeline(source, dir.path);
  await run.run();
  const perAccount = (name: string) =>
    rows(
      out,
      `SELECT ${name === 'accounts' ? 'id' : 'accountId'} AS accountId, count(*) AS n FROM ${name} GROUP BY 1 ORDER BY 1`,
    );

  await app.save(first, second);
  const added = counts(await run.run());
  assert.deepEqual(added.messages, { count: 8, deleted: 0 });
  assert.deepEqual(added.conversations, { count: 5, deleted: 0 });
  assert.deepEqual(perAccount('messages'), [
    { accountId: second.user, n: 8 },
    { accountId: user, n: 8 },
  ]);
  assert.deepEqual(
    rows(
      out,
      `SELECT accountId FROM conversations WHERE id = '${chat}' ORDER BY accountId`,
    ),
    [{ accountId: second.user }, { accountId: user }],
  );

  // The first account signed out: the app deleted its databases.
  await app.save(second);
  assert.deepEqual(counts(await run.run()), await unchanged(source));
  for (const name of [
    'accounts',
    'conversations',
    'messages',
    'messageReactions',
    'callLogs',
    'activities',
    'people',
    'installedApps',
  ])
    assert.deepEqual(
      perAccount(name).map(({ accountId }) => accountId),
      [second.user, user],
      name,
    );
});

test('people, meetings and searches the app drops stay, as do members and apps it no longer lists, while an app uninstalled where it still lists apps is deleted', async () => {
  const { dir, app, out } = await scratch();
  await using _ = dir;
  const base = account();
  await app.save(base);
  const source = new TeamsSource(app.directory);
  const run = await pipeline(source, dir.path);
  await run.run();

  // The app drops Ada's profile, the meeting (past the calendar's span) and
  // its search history, and no longer keeps the chat's members nor the
  // team's apps; for the user, the planner is uninstalled.
  await app.save({
    ...changing(base, chat, ({ members: _m, botMembers: _b, ...rest }) => rest),
    profiles: base.profiles.filter(({ mri }) => mri !== ada),
    meetings: [],
    searches: [],
    apps: {
      ...base.apps,
      team: null,
      user: {
        ...base.apps.user,
        appEntitlements: [{ id: 'app-offer', state: 'PreConsented' }],
      },
    },
  });
  const after = counts(await run.run());

  const nothing = { count: 0, deleted: 0 };
  for (const name of [
    'people',
    'meetings',
    'meetingAttendees',
    'searches',
    'conversationMembers',
  ])
    assert.deepEqual(after[name], nothing, name);
  assert.deepEqual(after.installedApps, { count: 0, deleted: 1 });
  assert.deepEqual(
    [
      'people',
      'meetings',
      'meetingAttendees',
      'searches',
      'conversationMembers',
    ].map((name) => rows(out, `SELECT count(*) AS n FROM ${name}`)[0]?.n),
    [2, 1, 1, 1, 3],
  );
  assert.deepEqual(
    rows(out, 'SELECT scope, appId FROM installedApps ORDER BY scope'),
    [{ scope: 'team', appId: 'app-wiki' }],
  );
});

test('an edit, a deletion, an unpin, a read, a chat left and a folder change reach the import, and nothing else is rewritten', async () => {
  const { dir, app, out } = await scratch();
  await using _ = dir;
  const base: Account = {
    ...account(),
    folders: [
      ...account().folders,
      {
        id: 'folder-2',
        name: 'Old',
        folderType: 'UserCreated',
        isDeleted: false,
        createdTime: ms('2026-07-03T09:00:00.000Z'),
        conversations: [],
      },
    ],
  };
  await app.save(base);
  const source = new TeamsSource(app.directory);
  const run = await pipeline(source, dir.path);
  await run.run();

  const edit = (c: Chain): Chain => {
    const [only] = Object.values(c.messageMap);
    if (only === undefined || c.conversationId !== chat) return c;
    if (only.id === ids.hello)
      return chain([
        {
          ...only,
          content: '<p>Hello Ezz, the spec v2 is attached</p>',
          properties: {
            ...only.properties,
            edittime: String(ms('2026-09-05T08:00:00.000Z')),
          },
        },
      ]);
    if (only.id === ids.reply)
      return chain([
        {
          ...only,
          content: '',
          contentHash: '0',
          properties: {
            languageStamp: 'languages=en:100;',
            deletetime: ms('2026-09-06T08:00:00.000Z'),
          },
        },
      ]);
    return c;
  };
  const left = {
    ...base,
    chains: base.chains.map(edit),
    conversations: base.conversations.filter(({ id }) => id !== channel),
    folders: base.folders
      .filter(({ id }) => id !== 'folder-2')
      .map((folder) => ({ ...folder, conversations: [] })),
  };
  await app.save(
    changing(left, chat, (conversation) => ({
      ...conversation,
      threadProperties: {
        ...(typeof conversation.threadProperties === 'object'
          ? conversation.threadProperties
          : {}),
        pinnedItems: '[]',
      },
      properties: {
        ...(typeof conversation.properties === 'object'
          ? conversation.properties
          : {}),
        consumptionhorizon: `${ms('2026-09-25T09:00:00.000Z')};${ms('2026-09-25T09:00:00.000Z')};1`,
      },
    })),
  );
  const changed = counts(await run.run());

  assert.deepEqual(changed.messages, { count: 2, deleted: 0 });
  assert.deepEqual(changed.messageQuotes, { count: 0, deleted: 1 });
  assert.deepEqual(changed.pins, { count: 0, deleted: 1 });
  assert.deepEqual(changed.conversations, { count: 1, deleted: 1 });
  assert.deepEqual(changed.folders, { count: 0, deleted: 1 });
  assert.deepEqual(changed.folderConversations, { count: 0, deleted: 1 });
  assert.deepEqual(changed.messageReactions, { count: 0, deleted: 0 });
  assert.deepEqual(
    rows(
      out,
      `SELECT id, content, editedAt, deletedAt FROM messages WHERE conversationId = '${chat}' AND id IN ('${ids.hello}', '${ids.reply}') ORDER BY id`,
    ),
    [
      {
        id: ids.hello,
        content: '<p>Hello Ezz, the spec v2 is attached</p>',
        editedAt: '2026-09-05T08:00:00.000Z',
        deletedAt: null,
      },
      {
        id: ids.reply,
        content: null,
        editedAt: null,
        deletedAt: '2026-09-06T08:00:00.000Z',
      },
    ],
  );
  assert.deepEqual(
    rows(out, `SELECT id, lastReadAt FROM conversations ORDER BY id`),
    [
      { id: chat, lastReadAt: '2026-09-25T09:00:00.000Z' },
      { id: team, lastReadAt: null },
      { id: '19:eyJfdHlwZSI6Ikdyb3VwIn0@EngageCommunity', lastReadAt: null },
      { id: notes, lastReadAt: null },
    ],
  );
  assert.deepEqual(counts(await run.run()), await unchanged(source));
});

test('a call, activity or saved entry gone from the part of its feed the app holds is deleted, and one the app pruned stays', async () => {
  const { dir, app, out } = await scratch();
  await using _ = dir;
  const base = account();
  await app.save(base);
  const source = new TeamsSource(app.directory);
  const run = await pipeline(source, dir.path);
  await run.run();
  const without = (state: Account, gone: readonly string[]): Account => ({
    ...state,
    chains: state.chains.filter(
      ({ messageMap }) =>
        !Object.values(messageMap).some(({ id }) => gone.includes(id)),
    ),
    saved: state.saved.filter(
      ({ messageMap }) =>
        !Object.values(messageMap).some(({ id }) => gone.includes(id)),
    ),
  });

  // Inside each feed's span: the first call, the mention and the saved
  // message go.
  const removed = without(base, [ids.call, ids.mention, ids.saved]);
  await app.save(removed);
  const first = counts(await run.run());
  assert.deepEqual(first.callLogs, { count: 0, deleted: 1 });
  assert.deepEqual(first.activities, { count: 0, deleted: 1 });
  assert.deepEqual(first.savedMessages, { count: 0, deleted: 1 });

  // The app prunes the call log, the reactions to the user's messages and the
  // older saved list past the rest of their entries, and drops them.
  const pruned = ['48:calllogs', '48:annotations', '48:starred'].reduce(
    (state, feed) => holding(state, feed, '2026-09-20T00:00:00Z'),
    without(removed, [ids.groupCall, ids.reaction, ids.starred]),
  );
  await app.save(pruned);
  const second = counts(await run.run());
  for (const name of [
    'callLogs',
    'callParticipants',
    'activities',
    'savedMessages',
  ])
    assert.deepEqual(second[name], { count: 0, deleted: 0 }, name);
  assert.deepEqual(
    [
      rows(out, 'SELECT id FROM callLogs'),
      rows(out, 'SELECT count(*) AS n FROM callParticipants'),
      rows(out, 'SELECT feed, id FROM activities'),
      rows(out, 'SELECT feed, id FROM savedMessages'),
    ],
    [
      [{ id: ids.groupCall }],
      [{ n: 2 }],
      [{ feed: 'annotations', id: ids.reaction }],
      [{ feed: 'starred', id: ids.starred }],
    ],
  );
});

test('an import scope keeps the selected accounts, conversations and dates, and keeps what belongs to the account alone', async () => {
  const { dir, app, out } = await scratch();
  await using _ = dir;
  const other: Account = {
    ...account(),
    tenant: '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a',
    user: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  };
  await app.save(account(), other);
  const source = new TeamsSource(app.directory, {
    accountIds: [user],
    collectionIds: [chat],
    startAt: '2026-09-02T00:00:00.000Z',
    endAt: '2026-09-04T00:00:00.000Z',
  });
  const run = await pipeline(source, dir.path);

  await run.run();

  assert.deepEqual(rows(out, 'SELECT id FROM accounts'), [{ id: user }]);
  assert.deepEqual(rows(out, 'SELECT accountId, id FROM conversations'), [
    { accountId: user, id: chat },
  ]);
  assert.deepEqual(rows(out, 'SELECT id FROM messages ORDER BY id'), [
    { id: ids.reply },
    { id: ids.deleted },
  ]);
  assert.deepEqual(
    [
      'messageQuotes',
      'messageReactions',
      'pins',
      'folderConversations',
      'conversationMembers',
      'people',
      'callLogs',
      'activities',
      'meetings',
      'installedApps',
    ].map((name) => [
      name,
      rows(out, `SELECT count(*) AS n FROM ${name}`)[0]?.n,
      rows(
        out,
        `SELECT count(*) AS n FROM ${name} WHERE accountId <> '${user}'`,
      )[0]?.n,
    ]),
    [
      ['messageQuotes', 1, 0],
      ['messageReactions', 0, 0],
      ['pins', 1, 0],
      ['folderConversations', 1, 0],
      ['conversationMembers', 3, 0],
      ['people', 2, 0],
      ['callLogs', 2, 0],
      ['activities', 2, 0],
      ['meetings', 1, 0],
      ['installedApps', 2, 0],
    ],
  );
});

test('a Teams watch wakes every stream once, again when the app writes its store, and stops when aborted', async () => {
  const { dir, app } = await scratch();
  await using _ = dir;
  const base = account();
  await app.save(base);
  const source = new TeamsSource(app.directory);
  const run = await pipeline(source, dir.path);
  const controller = new AbortController();
  const batches: Record<string, { count: number; deleted: number }>[] = [];

  for await (const { outcomes } of run.watch({
    // A batch that never comes ends the watch, so the assertion fails.
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  })) {
    batches.push(counts(outcomes));
    if (batches.length === 1)
      await app.save({
        ...base,
        chains: [
          ...base.chains,
          chain([
            message({
              conversationId: chat,
              id: id('2026-09-20T10:00:00.000Z'),
              content: '<p>one more thing</p>',
            }),
          ]),
        ],
      });
    // Past the next one-second poll, so a spurious batch would show.
    else setTimeout(() => controller.abort(), 1500);
  }

  const { streams } = await source.discover();
  const names = streams.map(({ name }) => name).sort();
  assert.equal(batches.length, 2);
  assert.deepEqual(Object.keys(batches[0] ?? {}).sort(), names);
  assert.deepEqual(Object.keys(batches[1] ?? {}).sort(), names);
  assert.deepEqual(batches[1]?.messages, { count: 1, deleted: 0 });

  // The source's own watch ends as soon as its signal aborts, rather than
  // polling the store every second for a host that stopped listening.
  const stop = new AbortController();
  const watch = source.watch({ streams, signal: stop.signal });
  assert.deepEqual((await watch.next()).value, streams);
  stop.abort();
  assert.deepEqual(
    await Promise.race([watch.next(), sleep(2500).then(() => 'still polling')]),
    { done: true, value: undefined },
  );
});

test('this Mac’s Teams app loads every account it keeps, and a second read with no write writes nothing', async (t) => {
  if (process.platform !== 'darwin')
    return t.skip('the Teams app’s store is on macOS');
  await using dir = await mkdtempDisposable(join(tmpdir(), 'teams-live-'));
  const out = join(dir.path, 'out.sqlite');
  const source = new TeamsSource();
  const run = await pipeline(source, dir.path);

  try {
    await run.run();
  } catch (error) {
    if (
      error instanceof PipelineError &&
      error.errors.every((cause) => cause instanceof TeamsUnavailableError)
    )
      return t.skip(
        'the Teams app is not installed, or this process lacks Full Disk Access',
      );
    throw error;
  }

  // Counted, never printed.
  const [accounts, conversations, messages] = [
    'accounts',
    'conversations',
    'messages',
  ].map((name) => rows(out, `SELECT count(*) AS n FROM ${name}`)[0]?.n);
  if (accounts === 0) return t.skip('the Teams app keeps no signed-in account');
  assert.ok(Number(conversations) > 0);
  assert.ok(Number(messages) > 0);
  assert.deepEqual(
    rows(
      out,
      `SELECT
         (SELECT count(*) FROM messages WHERE sentAt NOT LIKE '____-__-__T__:__:__.___Z') AS messages,
         (SELECT count(*) FROM callLogs WHERE startedAt NOT LIKE '____-__-__T__:__:__._______Z') AS calls`,
    ),
    [{ messages: 0, calls: 0 }],
  );
  // A read that finds an unchanged store writes nothing, so no field the app
  // keeps changes between two reads without a write. Teams writes its store
  // as it works; a write between the reads may carry real changes.
  const store = new TeamsStore();
  const before = store.version();
  const second = counts(await run.run());
  if (store.version() !== before)
    return t.skip('the Teams app wrote its store between the two reads');
  assert.deepEqual(second, await unchanged(source));
});

test('an account Teams keeps in two languages loads the set it synced last, and follows it when the language changes back', async () => {
  const { dir, app, out } = await scratch();
  await using _ = dir;
  const synced = (state: Account, at: string): Account => ({
    ...state,
    windows: state.windows.map((window) => ({
      ...window,
      lastSyncTime: ms(at),
    })),
  });
  const withMessage = (
    state: Account,
    content: string,
    sent: string,
  ): Account => ({
    ...state,
    chains: [
      ...state.chains,
      chain([message({ conversationId: chat, id: id(sent), content })]),
    ],
  });
  // Teams changed from English (United States) to English (United Kingdom):
  // its web client started a new set and left the old one behind.
  const stale = withMessage(
    synced({ ...account(), locale: 'en-us' }, '2026-09-30T00:00:00Z'),
    '<p>only in en-us</p>',
    '2026-09-20T10:00:00.000Z',
  );
  const live = withMessage(
    synced({ ...account(), locale: 'en-gb' }, '2026-10-01T00:00:00Z'),
    '<p>only in en-gb</p>',
    '2026-09-21T10:00:00.000Z',
  );
  await app.save(stale, live);
  const source = new TeamsSource(app.directory);
  const run = await pipeline(source, dir.path);
  const only = () =>
    rows(
      out,
      "SELECT content FROM messages WHERE content LIKE '<p>only in%' ORDER BY content",
    );

  await run.run();

  assert.deepEqual(only(), [{ content: '<p>only in en-gb</p>' }]);
  assert.deepEqual(rows(out, 'SELECT count(*) AS n FROM accounts'), [{ n: 1 }]);

  // Back to English (United States): the old set syncs again and is the one
  // the client reads.
  await app.save(synced(stale, '2026-10-02T00:00:00Z'), live);
  const back = counts(await run.run());

  assert.deepEqual(only(), [{ content: '<p>only in en-us</p>' }]);
  assert.deepEqual(back.messages, { count: 1, deleted: 1 });
});
