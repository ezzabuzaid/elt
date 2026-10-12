import type postgres from 'postgres';

import { AgentAutomation } from './agent-automation.ts';

type Order = {
  orderId: string;
  restaurant: string;
  receivedAt: string;
  receipt: string;
};

// "When I order food, log my calorie intake": each Careem delivery receipt in
// Mail, keyed by its order ID, so a second copy of a receipt adds nothing.
// The receipt names the restaurant and the dishes; the agent estimates the
// calories and keeps the log. Receipts from July 2026 on are HTML only.
export class CareemCalories extends AgentAutomation<Order> {
  readonly instruction =
    'Log my calorie intake from the food I ordered in food-log.md: one row per order with the date, restaurant, dishes and estimated kcal.';

  async evaluate(sql: postgres.Sql) {
    const orders = new Map<string, Order>();
    for (const { subject, receivedAt, plain, html } of await sql`
      SELECT s.subject, m."dateReceived" AS "receivedAt",
        (SELECT string_agg(p.text, E'\n' ORDER BY p."partId")
         FROM marts.mail_message_parts p WHERE p."messageId" = m.id
           AND p."contentType" = 'text/plain' AND NOT p."isAttachment") AS plain,
        (SELECT string_agg(p.text, E'\n' ORDER BY p."partId")
         FROM marts.mail_message_parts p WHERE p."messageId" = m.id
           AND p."contentType" = 'text/html' AND NOT p."isAttachment") AS html
      FROM marts.mail_messages m
      JOIN marts.mail_addresses a ON a.id = m.sender
      JOIN marts.mail_subjects s ON s.id = m.subject
      WHERE a.address = 'email@transactional.careem.com'
        AND s.subject LIKE 'Your Delivery%' AND m.deleted = 0
      ORDER BY m."dateReceived", m.id`) {
      if (typeof subject !== 'string' || !(receivedAt instanceof Date))
        continue;
      const receipt =
        typeof plain === 'string'
          ? plain.trim()
          : typeof html === 'string'
            ? text(html)
            : '';
      const orderId = /Order ID:\s*(\d+)/u.exec(receipt)?.[1];
      if (orderId === undefined || orders.has(orderId)) continue;
      orders.set(orderId, {
        orderId,
        restaurant: /From\s+(.+?)\s*$/u.exec(subject)?.[1] ?? subject,
        receivedAt: receivedAt.toISOString(),
        receipt,
      });
    }
    return [...orders.values()].map((order) => ({
      key: order.orderId,
      data: order,
    }));
  }
}

// The receipt's words without its markup: about 1 KB of text from a 130 KB
// message. Careem writes only these entities.
function text(html: string): string {
  return html
    .replaceAll(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
    .replaceAll(/<[^>]+>/gu, ' ')
    .replaceAll('&times;', '×')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}
