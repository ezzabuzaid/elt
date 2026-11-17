import { z } from 'zod';

import { timestamp } from './graph-values.ts';

export const LIST_FIELDS =
  'id,name,displayName,description,webUrl,createdDateTime,lastModifiedDateTime,list';

/**
 * A list of a site. A document library is a list too, with the template
 * `documentLibrary`.
 */
export const list = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  webUrl: z.string(),
  createdDateTime: timestamp,
  lastModifiedDateTime: timestamp,
  list: z.object({
    template: z.string(),
    hidden: z.boolean(),
    contentTypesEnabled: z.boolean(),
  }),
});

export type List = z.infer<typeof list>;
