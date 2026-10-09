import { SlackDesktopFormatError } from './errors.ts';
import { Fields } from './fields.ts';
import type {
  SlackApp,
  SlackAttachment,
  SlackBot,
  SlackChannel,
  SlackChannelKind,
  SlackChannelNote,
  SlackChannelSection,
  SlackClient,
  SlackFile,
  SlackFileShare,
  SlackListRecord,
  SlackMember,
  SlackMessage,
  SlackPreference,
  SlackReaction,
  SlackThreadSubscription,
} from './slack-client.ts';

// A client's persisted Redux state, as the app saves it under
// persist:slack-client-<workspace>-<user>: one slice per kind of thing, most
// keyed by id. Objects marked isNonExistent are the client's note that the
// thing is gone, not a thing.
export function readSlackClient(state: unknown, record: string): SlackClient {
  const root = new Fields(state, record, 'state');
  const workspaceId =
    root.object('selfTeamIds')?.requiredString('teamId') ??
    fail(record, 'state.selfTeamIds is missing');
  const userId = /-([A-Z0-9]+)$/.exec(record)?.[1];
  if (userId === undefined) fail(record, 'the record names no user');
  const workspace = root.object('teams')?.object(workspaceId);
  if (workspace === null || workspace === undefined)
    fail(record, `state.teams holds no ${workspaceId}`);
  const cursors = root.stringValues('channelCursors');
  const latests = root.stringValues('channelLatests');
  const reactionLists = root.object('reactions');
  const reactions = new Map(
    root
      .values('reactions')
      .map(([key]) => [key, reactionLists?.list(key).map(reaction) ?? []]),
  );
  const held = history(root, record);
  const existing = (fields: Fields) => fields.boolean('isNonExistent') !== true;
  const messagesByChannel = root.object('messages');
  const channelMessages = root.values('messages').flatMap(([channelId]) =>
    (messagesByChannel?.entries(channelId) ?? []).map(([, fields]) => ({
      channelId,
      fields,
    })),
  );
  // The client's notes that a message no longer exists, by channel and ts.
  const gone = new Set(
    channelMessages
      .filter(({ fields }) => !existing(fields))
      .map(
        ({ channelId, fields }) =>
          `${channelId} ${fields.requiredString('ts')}`,
      ),
  );
  return {
    workspace: {
      id: workspaceId,
      name: workspace.requiredString('name'),
      domain: workspace.requiredString('domain'),
      url: workspace.string('url'),
      emailDomain: workspace.string('email_domain'),
      plan: workspace.string('plan'),
      createdAt: seconds(workspace.number('date_created')),
      iconUrl: workspace.object('icon')?.string('image_230') ?? null,
    },
    userId,
    channels: root
      .entries('channels')
      .filter(([, fields]) => existing(fields))
      .map(([id, fields]) =>
        channel(id, fields, cursors.get(id) ?? null, latests.get(id) ?? null),
      ),
    members: root
      .entries('members')
      .filter(([, fields]) => existing(fields))
      .map(([id, fields]) => member(id, fields)),
    bots: root.entries('bots').map(([id, fields]) => bot(id, fields)),
    apps: root.entries('apps').map(([id, fields]) => app(id, fields)),
    messages: channelMessages
      .filter(
        ({ fields }) =>
          existing(fields) && fields.boolean('_hidden_reply') !== true,
      )
      .map(({ channelId, fields }) =>
        message(channelId, fields, record, reactions),
      ),
    threadReplies: channelMessages
      .filter(
        ({ fields }) =>
          existing(fields) && fields.boolean('_hidden_reply') === true,
      )
      .map(({ channelId, fields }) =>
        message(channelId, fields, record, reactions),
      ),
    files: root
      .entries('files')
      .filter(([, fields]) => existing(fields))
      .map(([id, fields]) => file(id, fields)),
    listRecords: listRecords(root, existing, record),
    channelSections: sections(root),
    threadSubscriptions: root
      .entries('threadSub')
      .map(([key, fields]) => threadSubscription(key, fields, record)),
    preferences: preferences(root, workspaceId),
    holds: (channelId, ts) =>
      gone.has(`${channelId} ${ts}`) ||
      (held.get(channelId) ?? []).some(
        ({ start, end }) =>
          compareTs(ts, start) >= 0 && compareTs(ts, end) <= 0,
      ),
  };
}

function fail(record: string, problem: string): never {
  throw new SlackDesktopFormatError(record, problem);
}

function seconds(value: number | null): string | null {
  return value === null || value === 0
    ? null
    : new Date(value * 1000).toISOString();
}

function milliseconds(value: number | null): string | null {
  return value === null || value === 0 ? null : new Date(value).toISOString();
}

// Slack's ts, seconds and six digits of microseconds, as an instant that
// keeps the microseconds.
function instant(ts: string, record: string): string {
  const match = /^(\d+)\.(\d{6})$/.exec(ts);
  if (match?.[1] === undefined || match[2] === undefined)
    fail(record, `message ts ${ts} is not seconds.microseconds`);
  return `${new Date(Number(match[1]) * 1000).toISOString().slice(0, 19)}.${match[2]}Z`;
}

function compareTs(a: string, b: string): number {
  const left = a.padStart(17, '0');
  const right = b.padStart(17, '0');
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// A ts of zeros means none.
function ts(value: string | null): string | null {
  return value === null || /^0+(\.0+)?$/.test(value) ? null : value;
}

function note(fields: Fields | null): SlackChannelNote {
  return {
    value: fields?.string('value') ?? null,
    setBy: fields?.string('creator') ?? null,
    setAt: seconds(fields?.number('last_set') ?? null),
  };
}

function kind(fields: Fields): SlackChannelKind {
  if (fields.boolean('is_im')) return 'im';
  if (fields.boolean('is_mpim')) return 'mpim';
  if (fields.boolean('is_private') || fields.boolean('is_group'))
    return 'private';
  return 'public';
}

function channel(
  id: string,
  fields: Fields,
  lastReadTs: string | null,
  latestTs: string | null,
): SlackChannel {
  return {
    id,
    name: fields.string('name'),
    kind: kind(fields),
    imUserId: fields.string('user'),
    createdAt: seconds(fields.number('created')),
    creatorId: fields.string('creator'),
    updatedAt: milliseconds(fields.number('updated')),
    isArchived: fields.boolean('is_archived'),
    isGeneral: fields.boolean('is_general'),
    isMember: fields.boolean('is_member'),
    isExternallyShared: fields.boolean('is_ext_shared'),
    isOrgShared: fields.boolean('is_org_shared'),
    topic: note(fields.object('topic')),
    purpose: note(fields.object('purpose')),
    previousNames: fields.strings('previous_names'),
    memberIds: fields.strings('members'),
    lastReadTs: ts(lastReadTs),
    latestTs: ts(latestTs),
  };
}

function member(id: string, fields: Fields): SlackMember {
  const profile = fields.object('profile');
  return {
    id,
    teamId: fields.string('team_id'),
    name: fields.string('name'),
    realName:
      fields.string('real_name') ?? profile?.string('real_name') ?? null,
    displayName: profile?.string('display_name') ?? null,
    firstName: profile?.string('first_name') ?? null,
    lastName: profile?.string('last_name') ?? null,
    title: profile?.string('title') ?? null,
    email: profile?.string('email') ?? null,
    phone: profile?.string('phone') ?? null,
    pronouns: profile?.string('pronouns') ?? null,
    timeZone: fields.string('tz'),
    statusText: profile?.string('status_text') ?? null,
    statusEmoji: profile?.string('status_emoji') ?? null,
    statusExpiresAt: seconds(profile?.number('status_expiration') ?? null),
    avatarUrl: profile?.string('image_192') ?? null,
    botId: profile?.string('bot_id') ?? null,
    appId: profile?.string('api_app_id') ?? null,
    isBot: fields.boolean('is_bot'),
    isAppUser: fields.boolean('is_app_user'),
    isDeleted: fields.boolean('deleted'),
    isAdmin: fields.boolean('is_admin'),
    isOwner: fields.boolean('is_owner'),
    isPrimaryOwner: fields.boolean('is_primary_owner'),
    isRestricted: fields.boolean('is_restricted'),
    isUltraRestricted: fields.boolean('is_ultra_restricted'),
    isInvited: fields.boolean('is_invited_user'),
    isSelf: fields.boolean('is_self'),
    updatedAt: seconds(fields.number('updated')),
  };
}

function bot(id: string, fields: Fields): SlackBot {
  return {
    id,
    name: fields.string('name'),
    appId: fields.string('app_id'),
    isDeleted: fields.boolean('deleted'),
    updatedAt: seconds(fields.number('updated')),
  };
}

function app(id: string, fields: Fields): SlackApp {
  return {
    id,
    name: fields.string('name'),
    description: fields.string('desc'),
    developerName: fields.string('developer_name'),
    appType: fields.string('app_type'),
    url: fields.string('url'),
    isInstalled: fields.boolean('is_installed'),
    isDistributed: fields.boolean('is_distributed'),
    isWorkflowApp: fields.boolean('is_workflow_app'),
  };
}

function reaction(fields: Fields): SlackReaction {
  return {
    name: fields.requiredString('name'),
    baseName: fields.string('baseName'),
    count: fields.requiredNumber('count'),
    userIds: fields.strings('users'),
  };
}

function attachment(fields: Fields): SlackAttachment {
  return {
    id: fields.string('id'),
    fallback: fields.string('fallback'),
    pretext: fields.string('pretext'),
    text: fields.string('text'),
    fromUrl: fields.string('from_url'),
    authorId: fields.string('author_id'),
    authorName: fields.string('author_name'),
    authorLink: fields.string('author_link'),
    channelId: fields.string('channel_id'),
    messageTs: fields.string('ts'),
    footer: fields.string('footer'),
    color: fields.string('color'),
    appId: fields.string('app_id'),
    botId: fields.string('bot_id'),
    isMessageUnfurl: fields.boolean('is_msg_unfurl'),
    isAppUnfurl: fields.boolean('is_app_unfurl'),
    fieldsJson: fields.json('fields'),
    blocksJson: fields.json('blocks'),
  };
}

function message(
  channelId: string,
  fields: Fields,
  record: string,
  reactions: ReadonlyMap<string, readonly SlackReaction[]>,
): SlackMessage {
  const ts = fields.requiredString('ts');
  const edited = fields.object('edited');
  const reactionKey = fields.string('_rxn_key');
  return {
    channelId,
    ts,
    sentAt: instant(ts, record),
    type: fields.requiredString('type'),
    subtype: fields.string('subtype'),
    userId: fields.string('user'),
    botId: fields.string('bot_id'),
    text: fields.string('text'),
    threadTs: fields.string('thread_ts'),
    replyCount: fields.number('reply_count'),
    replyUserIds: fields.strings('reply_users'),
    latestReplyTs: fields.string('latest_reply'),
    editedBy: edited?.string('user') ?? null,
    editedTs: edited?.string('ts') ?? null,
    clientMessageId: fields.string('client_msg_id'),
    isLocked: fields.boolean('is_locked'),
    isBeyondPlanLimit: fields.boolean('is_beyond_free_limit'),
    blocksJson: fields.json('blocks'),
    attachments: fields.list('attachments').map(attachment),
    reactions: reactionKey === null ? [] : (reactions.get(reactionKey) ?? []),
    fileIds: fields.strings('files'),
  };
}

function file(id: string, fields: Fields): SlackFile {
  const shares = fields.object('shares');
  return {
    id,
    name: fields.string('name'),
    title: fields.string('title'),
    mimetype: fields.string('mimetype'),
    filetype: fields.string('filetype'),
    prettyType: fields.string('pretty_type'),
    mode: fields.string('mode'),
    size: fields.number('size'),
    userId: fields.string('user'),
    createdAt: seconds(fields.number('created')),
    updatedAt: seconds(fields.number('updated')),
    editedAt: seconds(fields.number('edit_timestamp')),
    isExternal: fields.boolean('is_external'),
    externalType: fields.string('external_type'),
    isPublic: fields.boolean('is_public'),
    isDeleted: fields.boolean('is_deleted'),
    isTombstoned: fields.boolean('is_tombstoned'),
    urlPrivate: fields.string('url_private'),
    permalink: fields.string('permalink'),
    preview: fields.string('preview'),
    lines: fields.number('lines'),
    durationMs: fields.number('duration_ms'),
    width: fields.number('original_w'),
    height: fields.number('original_h'),
    listMetadataJson: fields.json('list_metadata'),
    transcriptionJson: fields.json('transcription'),
    shares: (['private', 'public'] as const).flatMap((visibility) =>
      (shares?.values(visibility) ?? []).flatMap(([channelId]) =>
        (shares?.object(visibility)?.list(channelId) ?? []).map(
          (share): SlackFileShare => ({
            channelId,
            ts: share.requiredString('ts'),
            isPrivate: visibility === 'private',
            sharedBy: share.string('share_user_id'),
          }),
        ),
      ),
    ),
  };
}

// The rows of each List the client loaded, keyed in the List by
// <list>-<record>.
function listRecords(
  root: Fields,
  existing: (fields: Fields) => boolean,
  record: string,
): SlackListRecord[] {
  return (root.object('lists')?.entries('listsById') ?? []).flatMap(
    ([listId, list]) =>
      list
        .entries('records')
        .filter(([, fields]) => existing(fields))
        .map(([, fields]) => ({
          listId,
          id: fields.requiredString('id'),
          position: fields.string('position'),
          parentRecordId: fields.string('parentRecordId'),
          threadTs: fields.string('threadTs'),
          createdAt: seconds(fields.number('dateCreated')),
          createdBy: fields.string('createdBy'),
          updatedAt: secondsText(fields.string('updatedTimestamp'), record),
          updatedBy: fields.string('updatedBy'),
          isArchived: fields.boolean('isArchived'),
          fieldsJson: fields.json('fields'),
        })),
  );
}

// Seconds the client keeps as text, such as a List row's update time.
function secondsText(value: string | null, record: string): string | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) fail(record, `${value} is not a count of seconds`);
  return seconds(Number(value));
}

// The ranges of each channel's history the client holds, as slices whose
// start and end are the ts of their oldest and newest message. A slice with
// neither, as the client keeps for a conversation it holds no message of,
// holds nothing.
function history(
  root: Fields,
  record: string,
): Map<string, { readonly start: string; readonly end: string }[]> {
  return new Map(
    root.entries('channelHistory').map(([channelId, fields]) => [
      channelId,
      fields.list('slices').flatMap((slice) => {
        const start = slice.string('start');
        const end = slice.string('end');
        if (start === null && end === null) return [];
        if (start === null || end === null)
          fail(record, `a slice of ${channelId}'s history has only one end`);
        return [{ start, end }];
      }),
    ]),
  );
}

// The sidebar's sections, in the order the client keeps them.
function sections(root: Fields): SlackChannelSection[] {
  const state = root.object('channelSections');
  if (state === null) return [];
  const channelIds = state.object('channelIdsByChannelSectionId');
  return state.list('orderedChannelSectionList').map((section, position) => {
    const id = section.requiredString('id');
    return {
      id,
      type: section.requiredString('type'),
      name: section.string('name'),
      emoji: section.string('emoji'),
      position,
      channelIds: channelIds?.strings(id) ?? [],
    };
  });
}

function threadSubscription(
  key: string,
  fields: Fields,
  record: string,
): SlackThreadSubscription {
  const match = /^([A-Z0-9]+)-(\d+\.\d+)$/.exec(key);
  if (match?.[1] === undefined || match[2] === undefined)
    fail(record, `thread subscription ${key} names no channel and ts`);
  return {
    channelId: match[1],
    threadTs: match[2],
    isSubscribed: fields.boolean('subscribed'),
    lastReadTs: fields.string('lastRead'),
  };
}

// The user's preferences, and the workspace's as its admins set them.
function preferences(root: Fields, workspaceId: string): SlackPreference[] {
  const team = root.object('teamPrefs');
  return [
    ...root.values('userPrefs').map(([name, value]) => ({
      scope: 'user' as const,
      name,
      valueJson: JSON.stringify(value),
    })),
    ...(team?.values(workspaceId) ?? []).map(([name, value]) => ({
      scope: 'team' as const,
      name,
      valueJson: JSON.stringify(value),
    })),
  ];
}
