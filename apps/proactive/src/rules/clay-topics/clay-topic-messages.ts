import type postgres from 'postgres';

import type { Reading } from '@eltjs/eca';

import { NotifyAutomation } from '../../engine/notify-automation.ts';

type Context = { readonly matches: boolean; readonly seconds: number };

type Message = { readonly text: string; readonly url: string };

// Sender scope is fixed for both topic rules. Other people's messages can
// supply context, but can never become notifications. Context is rebuilt
// from the warehouse each time, so a late-loaded thread parent is usable. A
// message matches when it is about the topic after and was not before; its
// URL names it by workspace, conversation and exact Slack timestamp.
export abstract class ClayTopicMessages extends NotifyAutomation<Message> {
  abstract readonly name: string;

  message({ text, url }: Message) {
    return `${text}\n${url}`;
  }

  protected abstract about(text: string, channelId: string): boolean;

  async evaluate(before: Reading<postgres.Sql>, after: Reading<postgres.Sql>) {
    const was = new Set((await this.#about(before.sql)).map(({ url }) => url));
    return (await this.#about(after.sql)).filter(({ url }) => !was.has(url));
  }

  async #about(sql: postgres.Sql): Promise<Message[]> {
    const rows = await sql`
      SELECT * FROM (
        SELECT DISTINCT ON ("channelId", ts)
          "channelId", ts, "userId", coalesce(text, '') AS text, "threadTs"
        FROM (
          SELECT "workspaceId", "channelId", ts, "userId", text,
            "threadTs", loaded_at, 0 AS origin
          FROM marts.slack_messages
          UNION ALL
          SELECT "workspaceId", "channelId", ts, "userId", text,
            "threadTs", loaded_at, 1 AS origin
          FROM marts.slack_thread_replies
        ) copies
        WHERE "workspaceId" = 'T20H06JTC'
        ORDER BY "channelId", ts, loaded_at DESC, origin
      ) messages
      ORDER BY ts::numeric, "channelId"`;

    const conversations = new Map<string, Context>();
    const threads = new Map<string, Context>();
    const matches: Message[] = [];
    for (const { channelId, ts, userId, text, threadTs } of rows) {
      if (
        typeof channelId !== 'string' ||
        typeof ts !== 'string' ||
        typeof text !== 'string' ||
        !(threadTs === null || typeof threadTs === 'string')
      )
        continue;
      const seconds = Number(ts);
      const isReply = threadTs !== null && threadTs !== ts;
      const previous = isReply
        ? threads.get(`${channelId}/${threadTs}`)
        : conversations.get(channelId);
      const context = {
        seconds,
        matches:
          this.about(text, channelId) ||
          (this.#continues(text) &&
            previous?.matches === true &&
            (isReply || seconds - previous.seconds <= 4 * 60 * 60)),
      };
      // A thread keeps its parent's topic even when an intervening reply
      // has no recognizable wording. Replies do not change channel context.
      // A new top-level subject replaces the conversation context.
      if (!isReply) {
        conversations.set(channelId, context);
        threads.set(`${channelId}/${ts}`, context);
      }
      if (userId !== 'U03CUQ5SCRY' || !context.matches) continue;
      matches.push({
        // Slack keeps an empty text for a message with no words, such as one
        // that only shares a file.
        text: `${this.name}: ${text === '' ? '(no text)' : text}`,
        url: `slack://channel?team=T20H06JTC&id=${channelId}&message=${ts}`,
      });
    }
    return matches;
  }

  // Only recognizable continuations inherit context. A message naming a
  // topic must match the rule on its own; "This was the MCP version" must
  // not inherit the BD topic of the preceding comparison message.
  #continues(text: string): boolean {
    if (
      /\b(?:mcp|agent|connector|plugin|semantic layer|proposal|rfp|team composition|relevant experience|generate section|bio skill|case[ -]study)\b/i.test(
        text,
      )
    )
      return false;
    return (
      text.trim() === '' ||
      /^\s*\^\^/u.test(text) ||
      /^(?:(?:ok(?:ay)?|ahh)[,!\s]*)?(?:thanks?(?: you)?|thank you)[!\s.]*$/iu.test(
        text.trim(),
      ) ||
      /\b(?:any update|thanks? for (?:this|the update)|let me know|will (?:take a look|check it)|still (?:missing|not finding)|keep testing|questions are in|seems to be working|all we need for now|can you (?:show me|give it another shot)|work in progress|working on it|how urgent|fixed (?:today|tomorrow))\b/iu.test(
        text,
      )
    );
  }
}
