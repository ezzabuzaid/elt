import { z } from 'zod';

import { identitySet, timestamp } from './graph-values.ts';

/** A modern page of the site's Site Pages library, without its content. */
export const sitePage = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string().optional(),
  webUrl: z.string(),
  pageLayout: z.string().optional(),
  eTag: z.string().optional(),
  // Graph's own example of a page list leaves it out.
  createdDateTime: timestamp.optional(),
  lastModifiedDateTime: timestamp,
  createdBy: identitySet.optional(),
  lastModifiedBy: identitySet.optional(),
  publishingState: z
    .object({ level: z.string(), versionId: z.string() })
    .optional(),
});

export type SitePage = z.infer<typeof sitePage>;

const TEXT = '#microsoft.graph.textWebPart';

const textWebPart = z
  .object({
    '@odata.type': z.literal(TEXT),
    id: z.string(),
    innerHtml: z.string(),
  })
  .transform(({ id, innerHtml }) => ({ id, innerHtml }));

export type TextWebPart = z.infer<typeof textWebPart>;

// Every web part that is not text, such as an image or a list view: it holds
// no text that people wrote.
const otherWebPart = z
  .object({
    '@odata.type': z.string().refine((type) => type !== TEXT),
    id: z.string(),
  })
  .transform(() => undefined);

const webParts = z.array(z.union([textWebPart, otherWebPart]));

/**
 * A page with its canvas, read for its text web parts: the HTML that people
 * wrote on the page, in the order of the canvas (each horizontal section's
 * columns from left to right, then the vertical section).
 */
export const pageCanvas = z
  .object({
    canvasLayout: z.object({
      horizontalSections: z.array(
        z.object({ columns: z.array(z.object({ webparts: webParts })) }),
      ),
      verticalSection: z.object({ webparts: webParts }).nullish(),
    }),
  })
  .transform(({ canvasLayout }): readonly TextWebPart[] =>
    [
      ...canvasLayout.horizontalSections.flatMap((section) =>
        section.columns.flatMap((column) => column.webparts),
      ),
      ...(canvasLayout.verticalSection?.webparts ?? []),
    ].filter((part) => part !== undefined),
  );
