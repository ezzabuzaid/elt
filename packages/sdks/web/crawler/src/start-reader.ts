import { z } from 'zod';

import { type Finding, Reader, type Visit } from './reader.ts';

/**
 * The starting URLs as pages, for a host whose inputs are the pages to read,
 * such as a home page whose menu lists a site's categories. It hands back
 * each starting URL and finds no other URL. The crawl downloads a starting
 * URL a second time to hand it back, so a page without HTTP validators costs
 * two downloads.
 */
export class StartReader extends Reader<null, null> {
  readonly notes = z.null();
  readonly states = z.null();

  open() {
    return null;
  }

  wants() {
    return false;
  }

  read({ request }: Visit<null>): readonly Finding<null>[] {
    if (!request.start || request.page) return [];
    return [
      {
        url: request.url,
        // The starting URL is the response itself, not a URL that it names.
        naming: null,
        lastModified: null,
        published: null,
        page: true,
        list: false,
        linked: false,
        tolerate: [],
        note: null,
        priority: 'page',
      },
    ];
  }
}
