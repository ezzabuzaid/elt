import { z } from 'zod';

import { timestamp } from './graph-values.ts';

export const SITE_FIELDS =
  'id,name,displayName,description,webUrl,createdDateTime,lastModifiedDateTime';

/** A SharePoint site. `id` is Graph's composite `<host>,<site collection>,<web>`. */
export const site = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  // Graph leaves out a description that nobody wrote.
  description: z.string().optional(),
  webUrl: z.string(),
  createdDateTime: timestamp,
  lastModifiedDateTime: timestamp,
});

export type Site = z.infer<typeof site>;

/**
 * The Graph path of the site at `url`, such as
 * `https://contoso.sharepoint.com/sites/Sales`:
 * `/sites/contoso.sharepoint.com:/sites/Sales`.
 */
export function sitePath(url: string): string {
  const { hostname, pathname } = new URL(url);
  const path = pathname.replace(/\/+$/, '');
  return path === '' ? `/sites/${hostname}` : `/sites/${hostname}:${path}`;
}
