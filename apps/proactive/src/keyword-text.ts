import type postgres from 'postgres';

import type { Condition } from '@workspace/eca';

// "Tell me when a text says proactive:": every received message that carries
// the marker, keyed by the message, so each one is told once. A text the user
// sends to themselves arrives as a received copy beside the sent one, so it
// counts once, which makes the rule easy to try.
export class KeywordText implements Condition<postgres.Sql, { text: string }> {
  async evaluate(sql: postgres.Sql) {
    return (
      await sql`SELECT guid, text FROM marts.messages_messages WHERE NOT "isFromMe" AND text ILIKE ${'%proactive:%'}`
    ).flatMap(({ guid, text }) =>
      typeof guid === 'string' && typeof text === 'string'
        ? [{ key: guid, data: { text } }]
        : [],
    );
  }
}
