import { z } from 'zod';

/**
 * One page of a delta query. A page with a `nextLink` has more pages after
 * it; the last page has a `deltaLink`, the link that a later delta starts at
 * to read the changes after this one.
 */
export type DeltaPage<T> =
  | { readonly items: readonly T[]; readonly nextLink: string }
  | { readonly items: readonly T[]; readonly deltaLink: string };

/** The schema of a delta page whose items `item` parses. */
export function deltaPage<T>(item: z.ZodType<T>): z.ZodType<DeltaPage<T>> {
  return z.union([
    z
      .object({
        value: z.array(item),
        '@odata.nextLink': z.string(),
        '@odata.deltaLink': z.never().optional(),
      })
      .transform((body) => ({
        items: body.value,
        nextLink: body['@odata.nextLink'],
      })),
    z
      .object({
        value: z.array(item),
        '@odata.nextLink': z.never().optional(),
        '@odata.deltaLink': z.string(),
      })
      .transform((body) => ({
        items: body.value,
        deltaLink: body['@odata.deltaLink'],
      })),
  ]);
}
