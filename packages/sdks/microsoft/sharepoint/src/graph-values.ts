import { z } from 'zod';

/** A Graph timestamp: ISO 8601 in UTC, such as `2026-11-17T09:30:00Z`. */
export const timestamp = z.iso.datetime();

const identity = z.object({
  id: z.string().optional(),
  displayName: z.string().optional(),
  email: z.string().optional(),
});

/** Graph's identitySet: the user, app or group that created or changed an item. */
export const identitySet = z.object({
  user: identity.optional(),
  application: identity.optional(),
  group: identity.optional(),
});

/** Graph's `deleted` facet: the item was deleted after the last delta link. */
export const deleted = z.object({ state: z.string().optional() });
