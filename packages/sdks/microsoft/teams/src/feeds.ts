import type { Fields } from './fields.ts';
import type {
  TeamsActivity,
  TeamsCallLog,
  TeamsSavedMessage,
} from './teams-client.ts';

// The client keeps its activity, call log and saved lists as conversations of
// its own, 48:<feed>, whose messages describe something elsewhere. Each reader
// returns null for a message it does not describe, which stays a message.

export function readCallLog(message: Fields): TeamsCallLog | null {
  const log = message.object('properties')?.parsedObject('call-log');
  if (log === null || log === undefined) return null;
  const originator = log.object('originatorParticipant');
  const target = log.object('targetParticipant');
  return {
    id: message.requiredString('id'),
    callId: log.requiredString('callId'),
    startedAt: log.instant('startTime', 7),
    connectedAt: log.instant('connectTime', 7),
    endedAt: log.instant('endTime', 7),
    direction: log.string('callDirection'),
    callType: log.string('callType'),
    state: log.string('callState'),
    originatorId: originator?.string('id') ?? log.string('originator'),
    originatorName: originator?.string('displayName') ?? null,
    targetId: target?.string('id') ?? log.string('target'),
    targetType: target?.string('type') ?? null,
    conversationId: log.string('threadId'),
    messageId: log.string('messageId'),
    forwardedTo:
      log.object('forwardingInfo')?.string('forwardingDestinationType') ?? null,
    participants: log.list('participantList').map((participant) => ({
      id: participant.requiredString('id'),
      type: participant.string('type'),
      tenantId: participant.string('tenantId'),
    })),
  };
}

// An entry of the activity feed (notifications) or of the reactions to the
// user's messages (annotations). Whether the user has read it, by the feed
// message's id, comes from the feed's own index.
export function readActivity(
  message: Fields,
  feed: string,
  read: ReadonlyMap<string, boolean | null>,
): TeamsActivity | null {
  const activity = message.object('properties')?.object('activity');
  if (activity === null || activity === undefined) return null;
  const id = message.requiredString('id');
  return {
    feed,
    id,
    activityId: activity.text('activityId'),
    type: activity.requiredString('activityType'),
    subtype: activity.string('activitySubtype'),
    occurredAt:
      activity.instant('activityTimestamp', 3) ??
      message.requiredMilliseconds('originalArrivalTime'),
    sourceConversationId: activity.string('sourceThreadId'),
    sourceThreadId: activity.text('sourceReplyChainId'),
    sourceMessageId: activity.text('sourceMessageId'),
    sourceUserId: activity.string('sourceUserId'),
    sourceUserName: activity.string('sourceUserImDisplayName'),
    sourceTopic: activity.string('sourceThreadTopic'),
    preview: activity.string('messagePreview'),
    isRead: read.get(id) ?? null,
  };
}

// A message the user saved: an activity in 48:saved, or in 48:starred, which
// is what Teams called saving before.
export function readSaved(
  message: Fields,
  feed: string,
): TeamsSavedMessage | null {
  const properties = message.object('properties');
  const id = message.requiredString('id');
  const activity = properties?.object('activity');
  if (activity !== null && activity !== undefined)
    return {
      feed,
      id,
      conversationId: activity.string('sourceThreadId'),
      threadId: activity.text('sourceReplyChainId'),
      messageId: activity.text('sourceMessageId'),
      savedAt:
        activity.instant('activityTimestamp', 3) ??
        message.requiredMilliseconds('originalArrivalTime'),
    };
  const starred = properties?.object('starred');
  if (starred === null || starred === undefined) return null;
  return {
    feed,
    id,
    conversationId: starred.string('threadId'),
    threadId: starred.string('parentMessageId'),
    messageId: starred.string('messageId'),
    savedAt: message.requiredMilliseconds('originalArrivalTime'),
  };
}
