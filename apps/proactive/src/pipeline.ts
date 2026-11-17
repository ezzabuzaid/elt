import { Pipeline } from '@eltjs/elt';
import { PostgresSyncHistory } from '@eltjs/elt-postgresql';

import appleCalendar from './connections/apple-calendar.ts';
import appleMail from './connections/apple-mail.ts';
import appleMessages from './connections/apple-messages.ts';
import slack from './connections/slack.ts';
import whatsapp from './connections/whatsapp.ts';
import { warehouseUrl } from './warehouse.ts';

export default new Pipeline({
  clock: globalThis,
  history: new PostgresSyncHistory({ url: warehouseUrl }),
  connections: [appleMessages, slack, whatsapp, appleCalendar, appleMail],
});
