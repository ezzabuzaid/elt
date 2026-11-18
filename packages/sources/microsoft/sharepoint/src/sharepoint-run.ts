import { join } from 'node:path';

import { type TemporaryDirectory, TemporaryFiles } from '@zukhruf/fs';

import type {
  Drive,
  List,
  SharePointClient,
  Site,
} from '@eltjs/sdk-microsoft-sharepoint';

import { type SiteScope, resolveFolders } from './folder-scope.ts';

/**
 * One read of SharePoint: the client, the site, drives and lists that the
 * run read, and the folder of the files that it staged. Each stream of the
 * run sees the same drives, lists and scope of a site, so the delta streams
 * read the collections that the drives and lists streams load. A read that
 * Graph refused is not kept: the next stream to ask for it asks Graph again.
 */
export class SharePointRun implements AsyncDisposable {
  readonly client: SharePointClient;
  readonly #staging: TemporaryDirectory;
  readonly #sites = new Map<string, Site>();
  readonly #drives = new Map<string, readonly Drive[]>();
  readonly #lists = new Map<string, readonly List[]>();
  readonly #scopes = new Map<string, SiteScope>();
  // The folder URLs of each site that the host limited to folders.
  readonly #folders: ReadonlyMap<string, readonly string[]>;

  private constructor(
    client: SharePointClient,
    folders: ReadonlyMap<string, readonly string[]>,
    staging: TemporaryDirectory,
  ) {
    this.client = client;
    this.#folders = folders;
    this.#staging = staging;
  }

  static async open(
    client: SharePointClient,
    folders: ReadonlyMap<string, readonly string[]>,
  ): Promise<SharePointRun> {
    return new SharePointRun(
      client,
      folders,
      await new TemporaryFiles().directory('elt-sharepoint-'),
    );
  }

  async site(url: string, signal: AbortSignal): Promise<Site> {
    const known = this.#sites.get(url);
    if (known !== undefined) return known;
    const site = await this.client.site(url, signal);
    this.#sites.set(url, site);
    return site;
  }

  async drives(url: string, signal: AbortSignal): Promise<readonly Drive[]> {
    const known = this.#drives.get(url);
    if (known !== undefined) return known;
    const { id } = await this.site(url, signal);
    const drives = await this.client.drives(id, signal);
    this.#drives.set(url, drives);
    return drives;
  }

  async lists(url: string, signal: AbortSignal): Promise<readonly List[]> {
    const known = this.#lists.get(url);
    if (known !== undefined) return known;
    const { id } = await this.site(url, signal);
    const lists = await this.client.lists(id, signal);
    this.#lists.set(url, lists);
    return lists;
  }

  // The whole site, or the folders the host limited it to, each resolved
  // once a run, so a folder renamed since the last run fails this one.
  async scope(url: string, signal: AbortSignal): Promise<SiteScope> {
    const known = this.#scopes.get(url);
    if (known !== undefined) return known;
    const urls = this.#folders.get(url);
    const scope =
      urls === undefined
        ? 'site'
        : await resolveFolders(
            this.client,
            await this.drives(url, signal),
            urls,
            signal,
          );
    this.#scopes.set(url, scope);
    return scope;
  }

  // Where a file named name stages in the run's folder. The caller removes
  // it once its record is loaded; the run removes what is left.
  staged(name: string): string {
    return join(this.#staging.path, name);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#staging.cleanup();
  }
}
