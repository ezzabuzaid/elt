import { fileURLToPath } from 'node:url';

import { Connection } from '@eltjs/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
} from '@eltjs/elt-postgresql';
import { CalendarStore } from '@eltjs/sdk-apple-eventkit';
import { AppleCalendarSource } from '@eltjs/source-apple-calendar/apple-calendar-source';

import { warehouseUrl } from '../warehouse.ts';
import { martsCopy } from './marts-copy.ts';

const endAt = new Date();
endAt.setUTCFullYear(endAt.getUTCFullYear() + 1);
const source = new AppleCalendarSource({
  store: new CalendarStore(
    fileURLToPath(
      import.meta.resolve('@eltjs/sdk-apple-eventkit/eventkit-helper'),
    ),
    { env: process.env },
  ),
  startAt: new Date().toISOString(),
  endAt: endAt.toISOString(),
});
const destination = new PostgresDestination({
  url: warehouseUrl,
  schema: 'apple_calendar',
});

export default new Connection({
  name: 'apple-calendar',
  source,
  destination,
  checkpoints: new PostgresCheckpointStore({
    url: warehouseUrl,
    schema: 'apple_calendar',
  }),
  steps: [source.calendars, source.events, source.attendees].map(
    martsCopy(destination, 'calendar'),
  ),
});
