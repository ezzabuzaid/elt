import { z } from 'zod';

import { deleted, identitySet, timestamp } from './graph-values.ts';

// A delta query gives only the properties it selects. It selects no
// @microsoft.graph.downloadUrl: that pre-signed URL changes at every read.
export const DRIVE_ITEM_FIELDS = [
  'id',
  'name',
  'size',
  'file',
  'folder',
  'root',
  'deleted',
  'parentReference',
  'webUrl',
  'createdDateTime',
  'lastModifiedDateTime',
  'createdBy',
  'lastModifiedBy',
  'eTag',
  'cTag',
  'sharepointIds',
].join(',');

const parentReference = z.object({
  driveId: z.string(),
  // The root folder of a drive has no parent ID.
  id: z.string().optional(),
  // Graph documents that a delta can leave the path out.
  path: z.string().optional(),
});

/** A file or a folder of a drive, as it is now. */
const presentDriveItem = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number(),
  file: z
    .object({
      mimeType: z.string(),
      hashes: z
        .object({
          quickXorHash: z.string().optional(),
          sha1Hash: z.string().optional(),
          sha256Hash: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  folder: z.object({ childCount: z.number() }).optional(),
  /** Present only on the root folder of the drive. */
  root: z.object({}).optional(),
  deleted: z.never().optional(),
  parentReference,
  webUrl: z.string(),
  createdDateTime: timestamp,
  lastModifiedDateTime: timestamp,
  createdBy: identitySet.optional(),
  lastModifiedBy: identitySet.optional(),
  // The root folder of a drive has none. A delta repeats the root on each of
  // its pages (live, 2026-11-17: 31 times over the 31 pages of one drive).
  eTag: z.string().optional(),
  // Graph documents that a delta of SharePoint can leave out the cTag.
  cTag: z.string().optional(),
  sharepointIds: z.object({ listItemId: z.string().optional() }).optional(),
});

/** A file or a folder that was deleted after the link that the delta started at. */
const deletedDriveItem = z.object({
  id: z.string(),
  deleted,
  parentReference: parentReference.optional(),
});

export const driveItem = z.union([presentDriveItem, deletedDriveItem]);

export type DriveItem = z.infer<typeof driveItem>;
