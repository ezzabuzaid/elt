import {
  type CopyConfiguration,
  type Properties,
  type SourceMessage,
  Stream,
  validateRecords,
} from '@eltjs/elt';

import type { SharePointRun } from './sharepoint-run.ts';

const text = { type: 'string' } as const;
const id = { ...text, minLength: 1 } as const;
const nullableText = { type: ['string', 'null'] } as const;
const boolean = { type: 'boolean' } as const;
const timestamp = { ...text, format: 'date-time' } as const;
const nullableTimestamp = {
  type: ['string', 'null'],
  format: 'date-time',
} as const;
// Graph gives sizes and counts as JSON numbers; a file of SharePoint is at
// most 250 GB, far below 2^53.
const count = { type: 'integer', minimum: 0 } as const;
const nullableCount = { type: ['integer', 'null'], minimum: 0 } as const;

export const sharePointFields = {
  text,
  id,
  nullableText,
  boolean,
  timestamp,
  nullableTimestamp,
  count,
  nullableCount,
};

export const siteUrl = {
  ...id,
  description:
    'The URL of the site as the host configured it, such as https://contoso.sharepoint.com/sites/Sales. Each stream is read once for each site.',
};

export const createdBy = {
  ...nullableText,
  description:
    "Who created it: the identitySet of Graph as JSON, with user, application or group, each with id, displayName and email when Graph gives them. Read a part with json_extract(createdBy, '$.user.email'). NULL when Graph gives none.",
};

export const lastModifiedBy = {
  ...nullableText,
  description:
    "Who changed it last: the identitySet of Graph as JSON, as createdBy. Read a part with json_extract(lastModifiedBy, '$.user.displayName'). NULL when Graph gives none.",
};

// What one stream is: its family decides how it syncs.
type StreamDefinition = {
  readonly name: string;
  // What one record is, its primary key, and how it syncs.
  readonly description: string;
  readonly properties: Properties;
  // siteUrl first: every stream is read once for each site.
  readonly primaryKey: readonly ['siteUrl', ...string[]];
  // What a pass over the stream reads, for the sync history.
  readonly covers: string;
  readonly supportsFileTransfer?: true;
};

/**
 * A SharePoint stream: its declaration, and how one read of one site turns
 * Graph's answers into messages. Each family that reads alike is a subclass:
 * the snapshots that Graph lists whole on each read, and the delta feeds.
 */
export abstract class SharePointStream {
  readonly stream: Stream;
  readonly covers: string;

  constructor({
    name,
    description,
    properties,
    primaryKey,
    covers,
    supportsFileTransfer,
  }: StreamDefinition) {
    this.stream = new Stream({
      name,
      jsonSchema: {
        type: 'object',
        description,
        properties,
        required: Object.keys(properties),
      },
      primaryKey,
      supportedSyncModes: ['full_refresh', 'incremental'],
      sourceDefinedCursor: true,
      emitsDeletes: true,
      partitionKey: ['siteUrl'],
      supportsFileTransfer,
    });
    this.covers = covers;
  }

  abstract extract(
    configuration: CopyConfiguration,
    state: unknown,
    siteUrl: string,
    run: SharePointRun,
    signal: AbortSignal,
  ): AsyncGenerator<SourceMessage>;

  // One record, checked against the schema as it is read, so a read holds
  // one record at a time.
  protected validated(draft: Record<string, unknown>): Record<string, unknown> {
    const [record] = validateRecords(this.stream, [draft], 'SharePoint');
    if (record === undefined)
      throw new TypeError(`SharePoint ${this.stream.name} lost a record`);
    return record;
  }
}

// Graph gives instants to the second (2026-11-17T09:30:00Z); they load in the
// canonical millisecond form of elt.
export function instant(value: string): string {
  return new Date(value).toISOString();
}

export function nullableInstant(value: string | undefined): string | null {
  return value === undefined ? null : instant(value);
}

// An identitySet of Graph, or any other value that Graph gives as an object,
// as JSON text; null when Graph gives none.
export function json(value: object | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
