import type { RecordDraft } from '@eltjs/elt';
import type { HistoryDownload } from '@eltjs/sdk-chromium-history';

import type { ChromiumScan, Profiled } from '../chromium-scan.ts';
import { ChromiumStream, chromiumFields } from '../chromium-stream.ts';

const { nullableText } = chromiumFields;

const properties = {
  profileId: chromiumFields.profileId,
  id: {
    ...chromiumFields.integer,
    description: 'The row id of the download in the profile’s History.',
  },
  guid: {
    ...chromiumFields.text,
    description: 'The id the browser gives the download for its life.',
  },
  currentPath: {
    ...chromiumFields.text,
    description: 'Where the file is while it downloads; empty when none.',
  },
  targetPath: {
    ...chromiumFields.text,
    description: 'Where the file goes when it is done; empty when none.',
  },
  startedAt: {
    ...chromiumFields.instant,
    description: 'When the download started.',
  },
  endedAt: {
    ...chromiumFields.instant,
    description: 'When the download ended; null while it runs.',
  },
  receivedBytes: {
    ...chromiumFields.integer,
    description: 'How many bytes the browser received.',
  },
  totalBytes: {
    ...chromiumFields.integer,
    description: 'The size the server announced; 0 when it announced none.',
  },
  state: {
    ...chromiumFields.integer,
    description:
      'As Chromium’s history DownloadState numbers it: 0 in progress, 1 complete, 2 cancelled, 4 interrupted.',
  },
  dangerType: {
    ...chromiumFields.integer,
    description:
      'What the browser judged of the file’s danger, as Chromium’s DownloadDangerType numbers it; 0 not dangerous.',
  },
  interruptReason: {
    ...chromiumFields.integer,
    description:
      'Why the download stopped, as Chromium’s DownloadInterruptReason numbers it; 0 none.',
  },
  hash: {
    ...nullableText,
    description: 'The SHA-256 of the file, in hex.',
  },
  opened: {
    ...chromiumFields.boolean,
    description: 'The user opened the file from the browser.',
  },
  lastAccessedAt: {
    ...chromiumFields.instant,
    description:
      'When the user last opened the file from the browser; null when never.',
  },
  transient: {
    ...chromiumFields.boolean,
    description: 'The browser does not show the download in its list.',
  },
  referrer: {
    ...nullableText,
    description: 'The referrer of the download request.',
  },
  siteUrl: {
    ...nullableText,
    description: 'The site the download is filed under.',
  },
  embedderDownloadData: {
    ...nullableText,
    description:
      'What the browser that embeds Chromium keeps for the download.',
  },
  tabUrl: {
    ...nullableText,
    description: 'The page of the tab that started the download.',
  },
  tabReferrerUrl: {
    ...nullableText,
    description: 'The referrer of the page of the tab.',
  },
  httpMethod: {
    ...nullableText,
    description: 'The HTTP method of the request, such as GET.',
  },
  byExtensionId: {
    ...nullableText,
    description: 'The extension that started the download.',
  },
  byExtensionName: {
    ...nullableText,
    description: 'The name of the extension that started the download.',
  },
  byWebAppId: {
    ...nullableText,
    description: 'The installed web app that started the download.',
  },
  etag: {
    ...nullableText,
    description: 'The ETag header of the response, as sent.',
  },
  lastModified: {
    ...nullableText,
    description: 'The Last-Modified header of the response, as sent.',
  },
  mimeType: {
    ...nullableText,
    description: 'The type of the file as the browser judged it.',
  },
  originalMimeType: {
    ...nullableText,
    description: 'The type of the file as the server sent it.',
  },
  urlChain: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Each URL the download went through, redirects first, the file last.',
  },
} as const;

export class DownloadsStream extends ChromiumStream<
  typeof properties,
  Profiled<HistoryDownload>
> {
  readonly name = 'downloads';
  readonly store = 'history';
  readonly description =
    'Each download in the History of a profile, until the user removes it from the list.';
  readonly properties = properties;
  readonly primaryKey = ['profileId', 'id'];

  protected rows(scan: ChromiumScan) {
    return scan.history.downloads();
  }

  protected record({
    profileId,
    row,
  }: Profiled<HistoryDownload>): RecordDraft<typeof properties> {
    return { profileId, ...row };
  }
}
