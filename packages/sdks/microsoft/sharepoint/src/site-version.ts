import { type Check, Gauge } from '@zukhruf/async';

import type { SharePointClient } from './sharepoint-client.ts';

/**
 * What changes when the content of a site does: the lastModifiedDateTime of
 * each of its lists, which include its document libraries, and of each of
 * its pages. A change watcher reads it as a gauge. Each read finds the site
 * first, so a site that the app cannot read fails that read, not the gauge's
 * creation (elt ADR 0020).
 */
export class SiteVersion extends Gauge<string> {
  readonly #client: SharePointClient;
  readonly #url: string;

  constructor(client: SharePointClient, url: string) {
    super();
    this.#client = client;
    this.#url = url;
  }

  protected async read({ signal }: Check): Promise<string> {
    const { id: siteId } = await this.#client.site(this.#url, signal);
    const [lists, pages] = await Promise.all([
      this.#client.lists(siteId, signal),
      this.#client.pages(siteId, signal),
    ]);
    return [
      ...lists.map((list) => `list ${list.id} ${list.lastModifiedDateTime}`),
      ...pages.map((page) => `page ${page.id} ${page.lastModifiedDateTime}`),
    ]
      .sort()
      .join('\n');
  }
}
