import type { RecordDraft } from '@eltjs/elt';
import type { PresentListItem } from '@eltjs/sdk-microsoft-sharepoint';

import {
  createdBy,
  instant,
  json,
  lastModifiedBy,
  sharePointFields,
  siteUrl,
} from './sharepoint-stream.ts';

const { id, text, timestamp } = sharePointFields;

// The template of the list of the requests for access to a site. Graph
// refuses its item delta with 503 serviceNotAvailable on each try, while a
// read of its items works (live, 2026-11-17), so accessRequests reads it in
// full and listItems leaves it out (ADR 0002).
export const accessRequestTemplate = 'accessRequest';

// The fields of an item of a list, the same in listItems and accessRequests.
export const listItemProperties = {
  siteUrl,
  listId: { ...id, description: 'The list of the item: lists.listId.' },
  itemId: {
    ...id,
    description:
      "SharePoint's ID of the item in its list, such as 12. In a document library, driveItems.listItemId refers to it.",
  },
  contentType: {
    ...text,
    description: 'The name of the content type of the item, such as Item.',
  },
  contentTypeId: {
    ...text,
    description: 'The ID of the content type of the item.',
  },
  webUrl: { ...text, description: 'The URL of the item.' },
  createdDateTime: {
    ...timestamp,
    description: 'When the item was created, in UTC.',
  },
  lastModifiedDateTime: {
    ...timestamp,
    description: 'When the item last changed, in UTC.',
  },
  createdBy,
  lastModifiedBy,
  eTag: {
    ...text,
    description: 'The version tag of the item, which changes when it changes.',
  },
  fields: {
    ...text,
    description:
      "The value of each column of the item that is not hidden, as JSON, by the name of the column (listColumns.name), as Graph gives it. Read one with json_extract(fields, '$.Title').",
  },
} as const;

export function listItemRecord(
  url: string,
  listId: string,
  item: PresentListItem,
): RecordDraft<typeof listItemProperties> {
  return {
    siteUrl: url,
    listId,
    itemId: item.id,
    contentType: item.contentType.name,
    contentTypeId: item.contentType.id,
    webUrl: item.webUrl,
    createdDateTime: instant(item.createdDateTime),
    lastModifiedDateTime: instant(item.lastModifiedDateTime),
    createdBy: json(item.createdBy),
    lastModifiedBy: json(item.lastModifiedBy),
    eTag: item.eTag,
    fields: JSON.stringify(item.fields),
  };
}
