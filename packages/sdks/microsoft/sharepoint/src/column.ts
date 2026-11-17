import { z } from 'zod';

const fields = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  columnGroup: z.string().optional(),
  hidden: z.boolean(),
  indexed: z.boolean(),
  readOnly: z.boolean(),
  required: z.boolean(),
  enforceUniqueValues: z.boolean(),
});

// Graph gives the type of a column as one facet, such as `text` or `choice`,
// that holds the settings of that type. The facets are mutually exclusive,
// and a column of a type that Graph does not model has none
// (columnDefinition).
const settings = z.record(z.string(), z.json()).optional();
const facets = z.object({
  boolean: settings,
  calculated: settings,
  choice: settings,
  contentApprovalStatus: settings,
  currency: settings,
  dateTime: settings,
  geolocation: settings,
  hyperlinkOrPicture: settings,
  lookup: settings,
  number: settings,
  personOrGroup: settings,
  term: settings,
  text: settings,
  thumbnail: settings,
});
const TYPES = facets.keyof().options;

/**
 * A column of a list: the name of a field that its items have, and its type,
 * or null for a type that Graph does not model.
 */
export const column = z
  // One body holds both the fields and the facets; each schema reads its own
  // keys of it.
  .preprocess(
    (body) => ({ fields: body, facets: body }),
    z.object({ fields, facets }),
  )
  .transform(({ fields, facets }) => {
    for (const name of TYPES) {
      const settings = facets[name];
      if (settings !== undefined)
        return { ...fields, type: { name, settings } };
    }
    return { ...fields, type: null };
  });

export type Column = z.infer<typeof column>;
