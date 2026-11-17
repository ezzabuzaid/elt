import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { z } from 'zod';

import { type Column, column } from './column.ts';
import { type DeltaPage, deltaPage } from './delta.ts';
import { DRIVE_ITEM_FIELDS, type DriveItem, driveItem } from './drive-item.ts';
import { DRIVE_FIELDS, type Drive, drive } from './drive.ts';
import {
  DeltaExpiredError,
  GraphError,
  SharePointSiteNotFoundError,
} from './errors.ts';
import { Graph, type SharePointClientOptions } from './graph.ts';
import {
  type ListItem,
  type PresentListItem,
  listItem,
  presentListItem,
} from './list-item.ts';
import { LIST_FIELDS, type List, list } from './list.ts';
import {
  type SitePage,
  type TextWebPart,
  pageCanvas,
  sitePage,
} from './page.ts';
import { SITE_FIELDS, type Site, site, sitePath } from './site.ts';

/**
 * Reads SharePoint Online through Microsoft Graph, as one app with an
 * app-only token. Each call stops when `signal` aborts.
 */
export class SharePointClient {
  readonly #graph: Graph;

  constructor(options: SharePointClientOptions) {
    this.#graph = new Graph(options);
  }

  /** The site at `url`, such as `https://contoso.sharepoint.com/sites/Sales`. */
  async site(url: string, signal: AbortSignal): Promise<Site> {
    try {
      return await this.#graph.json(
        `${sitePath(url)}?$select=${SITE_FIELDS}`,
        site,
        url,
        signal,
      );
    } catch (error) {
      if (error instanceof GraphError && error.status === 404)
        throw new SharePointSiteNotFoundError(url, { cause: error });
      throw error;
    }
  }

  /** The document libraries of the site. */
  drives(siteId: string, signal: AbortSignal): Promise<readonly Drive[]> {
    return this.#graph.collection(
      `/sites/${siteId}/drives?$select=${DRIVE_FIELDS}`,
      drive,
      siteId,
      signal,
    );
  }

  /**
   * The lists of the site, its document libraries and hidden lists included.
   * Graph leaves out the lists that it marks `system`.
   */
  lists(siteId: string, signal: AbortSignal): Promise<readonly List[]> {
    return this.#graph.collection(
      `/sites/${siteId}/lists?$select=${LIST_FIELDS}`,
      list,
      siteId,
      signal,
    );
  }

  /** The columns of a list that are not hidden. */
  columns(
    siteId: string,
    listId: string,
    signal: AbortSignal,
  ): Promise<readonly Column[]> {
    return this.#graph.collection(
      `/sites/${siteId}/lists/${listId}/columns`,
      column,
      siteId,
      signal,
    );
  }

  /** The modern pages of the site, without their content. */
  pages(siteId: string, signal: AbortSignal): Promise<readonly SitePage[]> {
    return this.#graph.collection(
      `/sites/${siteId}/pages`,
      sitePage,
      siteId,
      signal,
    );
  }

  /** The text web parts of a page, in the order of its canvas. */
  textWebParts(
    siteId: string,
    pageId: string,
    signal: AbortSignal,
  ): Promise<readonly TextWebPart[]> {
    return this.#graph.json(
      `/sites/${siteId}/pages/${pageId}/microsoft.graph.sitePage?$expand=canvasLayout`,
      pageCanvas,
      siteId,
      signal,
    );
  }

  /**
   * The files and folders of a drive: every one without `link`, else the
   * changes after it. `link` is a nextLink or a deltaLink of an earlier page.
   */
  driveDelta(
    driveId: string,
    link: string | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<DeltaPage<DriveItem>, void, undefined> {
    return this.#delta(
      link ?? `/drives/${driveId}/root/delta?$select=${DRIVE_ITEM_FIELDS}`,
      driveItem,
      `the drive ${driveId}`,
      signal,
    );
  }

  /**
   * The items of a list with their fields: every one without `link`, else
   * the changes after it. `link` is a nextLink or a deltaLink of an earlier
   * page.
   */
  listItemsDelta(
    siteId: string,
    listId: string,
    link: string | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<DeltaPage<ListItem>, void, undefined> {
    return this.#delta(
      link ?? `/sites/${siteId}/lists/${listId}/items/delta?$expand=fields`,
      listItem,
      siteId,
      signal,
    );
  }

  /**
   * Every item of a list, read in full. Graph serves no item delta for some
   * lists, such as the hidden `accessRequest` list, which answers 503
   * `serviceNotAvailable` on each try while its items read (live, 2026-11-17).
   */
  listItems(
    siteId: string,
    listId: string,
    signal: AbortSignal,
  ): Promise<readonly PresentListItem[]> {
    return this.#graph.collection(
      `/sites/${siteId}/lists/${listId}/items?$expand=fields`,
      presentListItem,
      siteId,
      signal,
    );
  }

  /**
   * Writes the content of a file of a drive to `path`, as it arrives. Graph
   * redirects to a pre-signed URL, which the request follows.
   */
  async download(
    driveId: string,
    itemId: string,
    path: string,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.#graph.get(
      `/drives/${driveId}/items/${itemId}/content`,
      `the drive ${driveId}`,
      signal,
    );
    // A 204 has no body: the file is empty.
    const body = response.body ?? Readable.from([]);
    await pipeline(body, createWriteStream(path), { signal });
  }

  async *#delta<T>(
    first: string,
    item: z.ZodType<T>,
    resource: string,
    signal: AbortSignal,
  ): AsyncGenerator<DeltaPage<T>, void, undefined> {
    const page = deltaPage(item);
    for (let next = first; ;) {
      const body = await this.#graph
        .json(next, page, resource, signal)
        .catch((error: unknown) => {
          if (error instanceof GraphError && error.status === 410)
            throw new DeltaExpiredError({ cause: error });
          throw error;
        });
      yield body;
      if ('deltaLink' in body) return;
      next = body.nextLink;
    }
  }
}
