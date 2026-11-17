import { z } from 'zod';

import { timestamp } from './graph-values.ts';

export const DRIVE_FIELDS =
  'id,name,description,driveType,webUrl,createdDateTime,lastModifiedDateTime';

/** A document library of a site, as Graph shows it: a drive of files and folders. */
export const drive = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  driveType: z.string(),
  webUrl: z.string(),
  createdDateTime: timestamp,
  lastModifiedDateTime: timestamp,
});

export type Drive = z.infer<typeof drive>;
