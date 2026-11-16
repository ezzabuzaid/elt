import type postgres from 'postgres';

import type { Reading } from '@eltjs/eca';

import { NotifyAutomation } from '../../engine/notify-automation.ts';

type Marked = { readonly text: string };

// "Tell me when a text says proactive:": every received message that carries
// the marker, which matches when it is in after and was not in before. A text
// the user sends to themselves arrives as a received copy beside the sent
// one, so it counts once, which makes the rule easy to try.
export class KeywordText extends NotifyAutomation<Marked> {
  message({ text }: Marked) {
    return text;
  }

  async evaluate(before: Reading<postgres.Sql>, after: Reading<postgres.Sql>) {
    const was = await marked(before.sql);
    return [...(await marked(after.sql))]
      .filter(([guid]) => !was.has(guid))
      .map(([, text]) => ({ text }));
  }
}

// The text of each received message with the marker, by its guid.
async function marked(sql: postgres.Sql): Promise<Map<string, string>> {
  return new Map(
    (
      await sql`SELECT guid, text FROM marts.messages_messages WHERE NOT "isFromMe" AND text ILIKE ${'%proactive:%'}`
    ).flatMap(({ guid, text }) =>
      typeof guid === 'string' && typeof text === 'string'
        ? [[guid, text]]
        : [],
    ),
  );
}
