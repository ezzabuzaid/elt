import type { RecordDraft } from '@workspace/elt';

import type { SafariScan } from '../safari-scan.ts';
import { SafariStream, safariFields } from '../safari-stream.ts';
import { type Row, appleTime, base64, text } from '../safari-values.ts';

const { profileId, nullableText, nullableTimestamp } = safariFields;

const properties = {
  profileId,
  id: {
    ...safariFields.integer,
    description: 'History.db history_tombstones.id.',
  },
  startAt: {
    ...nullableTimestamp,
    description:
      'Start of the cleared time range; NULL when it is unbounded (Safari stores the year 1).',
  },
  endAt: {
    ...nullableTimestamp,
    description: 'End of the cleared time range; NULL when it is unbounded.',
  },
  url: {
    ...nullableText,
    description:
      'The URL whose history was removed, when Safari stored it as text; NULL otherwise.',
  },
  encryptedUrl: {
    ...nullableText,
    description:
      'The removed URL as Safari stores it for iCloud sync, encrypted, in base64. Safari 27 stores deleted URLs this way; NULL when the whole range was cleared or the URL is plain text.',
  },
  generation: {
    ...safariFields.integer,
    description: 'Safari history sync generation of the deletion.',
  },
  deviceId: {
    ...nullableText,
    description:
      'Identifier of the device that made the deletion, if recorded.',
  },
  attributes: {
    ...safariFields.ordinal,
    description:
      'Safari tombstone attribute bit mask as stored; Apple does not document the bits.',
  },
} as const;

export class HistoryTombstonesStream extends SafariStream<
  typeof properties,
  Row
> {
  readonly name = 'historyTombstones';
  readonly store = 'history';
  readonly primaryKey = ['profileId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per history deletion Safari keeps to sync to other devices (History.db history_tombstones): a removed URL or a cleared time range. Visits Safari expires by age leave no tombstone. Relationships name streams in this source, not physical destination tables.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SafariScan): readonly Row[] {
    return scan.history.profiles.flatMap((history) => history.tombstones);
  }

  protected record(row: Row): RecordDraft<typeof properties> {
    return {
      profileId: row.$profile,
      id: row.id,
      startAt: appleTime(row.start_time),
      endAt: appleTime(row.end_time),
      url: text(row.url),
      encryptedUrl: base64(row.url),
      generation: row.generation,
      deviceId: text(row.udid),
      attributes: row.attributes,
    };
  }
}
