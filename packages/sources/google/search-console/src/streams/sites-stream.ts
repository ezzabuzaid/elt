import type { Partition } from '@workspace/elt';

import { ListingStream } from '../listing-stream.ts';
import type { SearchConsoleScan } from '../search-console-scan.ts';
import { searchConsoleFields } from '../search-console-stream.ts';

const { id, nullableText } = searchConsoleFields;

const properties = {
  siteUrl: {
    ...id,
    description:
      'The property: sc-domain:<domain> for a domain property, or the URL prefix of a URL-prefix property.',
  },
  permissionLevel: {
    ...nullableText,
    description:
      'The access the grant has to the property: siteOwner, siteFullUser or siteRestrictedUser.',
  },
};

export class SitesStream extends ListingStream {
  constructor() {
    super({
      name: 'sites',
      description:
        'One record per Search Console property the Google grant can read, also properties the configuration does not select. A property where the grant is an unverified user is not here, because its history cannot be read. Primary key siteUrl. An incremental read deletes a property that Google no longer lists.',
      properties,
      primaryKey: ['siteUrl'],
    });
  }

  /**
   * Properties the grant can read. An unverified user is listed but cannot
   * read a property's history, so it is not one this connector can extract.
   */
  protected async list(
    _partition: Partition | null,
    scan: SearchConsoleScan,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>[]> {
    const { siteEntry = [] } = await scan.api.sites({ signal });
    return siteEntry
      .filter((entry) => entry.permissionLevel !== 'siteUnverifiedUser')
      .map(({ siteUrl, permissionLevel }) => ({ permissionLevel, siteUrl }));
  }
}
