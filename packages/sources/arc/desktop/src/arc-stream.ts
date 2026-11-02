import {
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  Stream,
  validateRecords,
} from '@workspace/elt';
import type { ArcSidebarContent } from '@workspace/sdk-arc-desktop';
import {
  type ImportScope,
  selected,
} from '@workspace/source-apple-macos/import-scope';

export const fields = {
  id: { type: 'string', minLength: 1 },
  text: { type: 'string' },
  nullableText: { type: ['string', 'null'] },
  nullableBoolean: { type: ['boolean', 'null'] },
  instant: { type: 'string', format: 'date-time', precision: 6 },
  nullableInstant: {
    type: ['string', 'null'],
    format: 'date-time',
    precision: 6,
  },
  position: { type: 'integer', minimum: 0 },
  profileId: {
    type: 'string',
    minLength: 1,
    description:
      'The Chromium profile folder of the profile, such as Default or Profile 2; the profile id of source-chromium-browser’s streams for Arc.',
  },
} as const;

// A stream of the sidebar: the whole file is one snapshot, so each stream
// lists every record of the selected profiles, and the diff deletes what
// left the file.
export abstract class ArcStream<P extends Properties> {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly properties: P;

  // A new Stream each call: the source asks once, for its catalog.
  describe(): Stream {
    return new Stream({
      name: this.name,
      jsonSchema: {
        type: 'object',
        description: this.description,
        properties: this.properties,
        required: Object.keys(this.properties),
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh', 'incremental'],
      sourceDefinedCursor: true,
      emitsDeletes: true,
    });
  }

  records(sidebar: ArcSidebarContent, scope: ImportScope): SchemaRecord<P>[] {
    return validateRecords(
      { name: this.name, jsonSchema: { properties: this.properties } },
      this.rows(sidebar).filter((row) =>
        selected(scope.collectionIds, row.profileId),
      ),
      'Arc',
    );
  }

  protected abstract rows(
    sidebar: ArcSidebarContent,
  ): (RecordDraft<P> & { readonly profileId: string })[];
}
