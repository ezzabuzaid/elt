import { z } from 'zod';

import { deleted, identitySet, timestamp } from './graph-values.ts';

/**
 * An item of a list, as it is now. `fields` holds its value of each column
 * that is not hidden, by the column's `name`.
 */
export const presentListItem = z.object({
  id: z.string(),
  eTag: z.string(),
  webUrl: z.string(),
  createdDateTime: timestamp,
  lastModifiedDateTime: timestamp,
  createdBy: identitySet.optional(),
  lastModifiedBy: identitySet.optional(),
  contentType: z.object({ id: z.string(), name: z.string() }),
  fields: z.record(z.string(), z.json()),
  deleted: z.never().optional(),
});

/** An item that was deleted after the link that the delta started at. */
const deletedListItem = z.object({ id: z.string(), deleted });

export const listItem = z.union([presentListItem, deletedListItem]);

export type ListItem = z.infer<typeof listItem>;

/** An item of a list read in full, which holds no deleted item. */
export type PresentListItem = z.infer<typeof presentListItem>;
