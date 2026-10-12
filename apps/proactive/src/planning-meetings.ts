import { createHash } from 'node:crypto';

import type postgres from 'postgres';

import type { Match } from '@workspace/eca';

import { Automation } from './automation.ts';
import type { MeetingBriefWriter } from './meeting-brief-writer.ts';

type Meeting = {
  eventId: string;
  name: string;
  startAt: Date;
  endAt: Date;
  body: string | null;
  location: string | null;
  url: string | null;
  attendees: { name: string | null; url: string | null; status: number }[];
};

type Conversation = {
  id: string;
  conversation: string;
  at: Date;
  author: string;
  text: string;
  url: string | null;
};

export type MeetingBrief = {
  meeting: Meeting;
  conversations: Conversation[];
  coverage: {
    connector: string;
    status: string;
    lastSuccessfulSyncAt: string | null;
  }[];
};

// A revision is a new match: changing a meeting or one of its conversations
// refreshes its one brief, without changing Eca's new-key semantics.
export class PlanningMeetings extends Automation<MeetingBrief> {
  readonly #briefs: MeetingBriefWriter;
  readonly #now: () => Date;

  constructor(briefs: MeetingBriefWriter, now: () => Date = () => new Date()) {
    super();
    this.#briefs = briefs;
    this.#now = now;
  }

  async act({ data }: Match<MeetingBrief>, signal: AbortSignal) {
    const path = await this.#briefs.write(data, signal);
    process.stdout.write(`Meeting brief: ${path}\n`);
    return `Planning brief ready: ${data.meeting.name}\n${path}`;
  }

  async evaluate(sql: postgres.Sql): Promise<Match<MeetingBrief>[]> {
    const now = this.#now();
    const meetings = (
      await sql<Meeting[]>`
      SELECT e."eventId", e.name, e."startAt", e."endAt", e.body, e.location, e.url,
        coalesce((SELECT jsonb_agg(jsonb_build_object(
          'name', a.name, 'url', a.url, 'status', a.status) ORDER BY a.id)
          FROM marts.calendar_attendees a WHERE a."eventId" = e."eventId"
            AND NOT a."isCurrentUser" AND a.status IS DISTINCT FROM 3
            AND a.type IS DISTINCT FROM 2), '[]'::jsonb) AS attendees
      FROM marts.calendar_events e
      JOIN marts.calendar_calendars c ON c.id = e."calendarId"
      WHERE NOT e."allDay" AND e.status IS DISTINCT FROM 3
        AND NOT c.subscribed AND c.type IN (0, 1, 2)
        AND e."startAt" >= ${now}
      ORDER BY e."eventId"`
    ).filter(({ name }) =>
      /\b(?:planning|plan|prep|preparation|formulation|kick[ -]?off|strategy|agenda)\b|تخطيط|تحضير/u.test(
        name.toLowerCase(),
      ),
    );
    if (meetings.length === 0) return [];

    const since = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
    const slack = await sql<Conversation[]>`
      SELECT 'Slack/' || "workspaceId" || '/' || "channelId" || '/' || ts AS id,
        'Slack/' || "workspaceId" || '/' || "channelId" || '/' || coalesce("threadTs", ts) AS conversation,
        "sentAt" AS at, coalesce("userId", 'Unknown') AS author, coalesce(text, '') AS text,
        'slack://channel?team=' || "workspaceId" || '&id=' || "channelId" || '&message=' || ts AS url
      FROM (
        SELECT DISTINCT ON ("workspaceId", "channelId", ts) * FROM (
          SELECT "workspaceId", "channelId", ts, "threadTs", "sentAt", "userId", text, loaded_at, 0 AS origin
          FROM marts.slack_messages
          UNION ALL
          SELECT "workspaceId", "channelId", ts, "threadTs", "sentAt", "userId", text, loaded_at, 1 AS origin
          FROM marts.slack_thread_replies
        ) copies ORDER BY "workspaceId", "channelId", ts, loaded_at DESC, origin
      ) messages WHERE "sentAt" BETWEEN ${since} AND ${now}`;
    const messages = await sql<Conversation[]>`
      SELECT 'Messages/' || m.guid || '/' || cm."chatGuid" AS id,
        'Messages/' || cm."chatGuid" AS conversation, m.date AS at,
        CASE WHEN m."isFromMe" THEN 'Me' ELSE coalesce(m.handle, 'Unknown') END AS author,
        coalesce(m.text, '') AS text, NULL::text AS url
      FROM marts.messages_messages m
      JOIN marts.messages_chat_messages cm ON cm."messageGuid" = m.guid
      WHERE m.date BETWEEN ${since} AND ${now}`;
    const mail = await sql<Conversation[]>`
      SELECT 'Mail/' || m.id || '/' || coalesce(cm."conversationId", '') AS id,
        'Mail/' || coalesce(cm."conversationId", 'message/' || m.id) AS conversation,
        m."dateReceived" AS at, coalesce(a.address, 'Unknown') AS author,
        coalesce(m."subjectPrefix", '') || coalesce(s.subject, '') || E'\n' ||
        coalesce(
          (SELECT string_agg(p.text, E'\n' ORDER BY p."partId")
           FROM marts.mail_message_parts p WHERE p."messageId" = m.id
             AND p."contentType" = 'text/plain' AND NOT p."isAttachment"),
          (SELECT string_agg(p.text, E'\n' ORDER BY p."partId")
           FROM marts.mail_message_parts p WHERE p."messageId" = m.id
             AND p."contentType" = 'text/html' AND NOT p."isAttachment"),
          '[Message body is not available on this Mac.]') AS text,
        g."messageIdHeader" AS url
      FROM marts.mail_messages m
      LEFT JOIN marts.mail_conversation_messages cm ON cm."messageId" = m."messageId"
      LEFT JOIN marts.mail_addresses a ON a.id = m.sender
      LEFT JOIN marts.mail_subjects s ON s.id = m.subject
      LEFT JOIN marts.mail_message_global_data g ON g.id = m."globalMessageId"
      WHERE m."dateReceived" BETWEEN ${since} AND ${now} AND m.deleted = 0`;
    for (const message of mail)
      if (message.url !== null)
        message.url = `message://${encodeURIComponent(message.url)}`;
    const conversations = [...slack, ...messages, ...mail].sort(
      (a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id),
    );
    const coverage = await sql<MeetingBrief['coverage']>`
      SELECT connector, status, last_successful_sync_at::text AS "lastSuccessfulSyncAt"
      FROM marts.sync_status WHERE connector IN ('apple-calendar', 'apple-mail', 'apple-messages', 'slack')
      ORDER BY connector`;
    return meetings.map((meeting) => {
      // Keep distinctive title words. A generic "Planning meeting" can
      // still be briefed from Calendar, but must not match every conversation.
      const terms = [
        ...new Set(meeting.name.toLowerCase().match(/[\p{L}\p{N}]+/gu)),
      ]
        .filter(
          (word) =>
            !/^(?:a|an|the|and|with|for|of|to|meeting|meetup|planning|plan|prep|preparation|formulation|kick|off|kickoff|strategy|agenda|call|sync|تخطيط|تحضير|اجتماع)$/.test(
              word,
            ),
        )
        .map(
          (word) =>
            new RegExp(
              `(?<![\\p{L}\\p{N}])${RegExp.escape(word)}(?![\\p{L}\\p{N}])`,
              'iu',
            ),
        );
      const related = new Set(
        conversations
          .filter(
            ({ text }) =>
              (terms.length > 0 && terms.every((term) => term.test(text))) ||
              (meeting.url !== null && text.includes(meeting.url)),
          )
          .map(({ conversation }) => conversation),
      );
      const evidence = conversations.filter(({ conversation }) =>
        related.has(conversation),
      );
      const revision = createHash('sha256')
        .update(JSON.stringify([meeting, evidence]))
        .digest('hex');
      return {
        key: `${meeting.eventId}/${revision}`,
        // Sync timestamps describe coverage, but never change a revision on
        // their own: a successful import with no source changes is quiet.
        data: { meeting, conversations: evidence, coverage },
      };
    });
  }
}
