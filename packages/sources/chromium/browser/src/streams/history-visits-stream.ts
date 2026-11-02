import type { RecordDraft } from '@workspace/elt';
import {
  type HistoryVisit,
  transitionQualifierNames,
  transitionTypes,
} from '@workspace/sdk-chromium-history';

import type { ChromiumScan, Profiled } from '../chromium-scan.ts';
import { ChromiumStream, chromiumFields } from '../chromium-stream.ts';

const visitReference = (description: string) =>
  ({ ...chromiumFields.nullableInteger, description }) as const;

const context = (description: string) =>
  ({
    ...chromiumFields.nullableInteger,
    description: `${description} Null when the browser kept no context for the visit.`,
  }) as const;

// A random 64-bit id, past what a JSON number holds.
const taskId = (description: string) =>
  ({
    type: ['string', 'null'],
    format: 'int64',
    description: `${description} -1 is none; null when the browser kept no context for the visit.`,
  }) as const;

const properties = {
  profileId: chromiumFields.profileId,
  id: {
    ...chromiumFields.integer,
    description: 'The row id of the visit in the profile’s History.',
  },
  urlId: {
    ...chromiumFields.integer,
    description:
      'The URL visited; refers to historyItems.id of the same profile.',
  },
  visitedAt: {
    ...chromiumFields.instant,
    description:
      'When the visit happened; null when the browser recorded no time.',
  },
  fromVisitId: visitReference(
    'The visit whose page linked or redirected to this one; refers to historyVisits.id of the same profile.',
  ),
  externalReferrerUrl: {
    ...chromiumFields.nullableText,
    description:
      'The referrer an app outside the browser gave when it opened the page.',
  },
  transition: {
    ...chromiumFields.integer,
    description:
      'How the visit began, as the browser stores it: a core type in the low byte and qualifier bits above it, as a signed 32-bit integer. transitionType and transitionQualifiers decode it.',
  },
  transitionType: {
    type: ['string', 'null'],
    enum: transitionTypes,
    description:
      'The core type of transition, as Chromium’s page_transition_types.h names it: link, typed (the address bar), auto_bookmark, auto_subframe (a frame that loaded on its own), manual_subframe, generated (an address bar suggestion), auto_toplevel, form_submit, reload, keyword, keyword_generated. Null for a type this reader does not know.',
  },
  transitionQualifiers: {
    type: 'array',
    items: { type: 'string', enum: transitionQualifierNames },
    description:
      'The qualifier bits of the transition, such as forward_back, from_address_bar, chain_start, chain_end, client_redirect and server_redirect.',
  },
  segmentId: visitReference(
    'The segment of the browser’s most-visited count the visit adds to.',
  ),
  durationMicros: {
    ...chromiumFields.integer,
    description:
      'How long the page stayed open, in microseconds; 0 when unknown.',
  },
  incrementedOmniboxTypedScore: {
    ...chromiumFields.boolean,
    description:
      'The visit added to the score the address bar ranks typed URLs by.',
  },
  openerVisitId: visitReference(
    'The visit of the page that opened this one in a new tab or window; refers to historyVisits.id of the same profile.',
  ),
  originatorCacheGuid: {
    ...chromiumFields.nullableText,
    description:
      'The sync id of the device the visit happened on, for a visit that came through sync.',
  },
  originatorVisitId: visitReference(
    'The id of the visit on the device it came from, for a visit that came through sync.',
  ),
  originatorFromVisitId: visitReference(
    'fromVisitId on the device the visit came from.',
  ),
  originatorOpenerVisitId: visitReference(
    'openerVisitId on the device the visit came from.',
  ),
  knownToSync: {
    ...chromiumFields.boolean,
    description: 'Sync has the visit.',
  },
  considerForNtpMostVisited: {
    ...chromiumFields.boolean,
    description:
      'The visit counts toward the most-visited sites of the new tab page.',
  },
  visitedLinkId: visitReference(
    'The row of the browser’s visited-link table that colours the link.',
  ),
  appId: {
    ...chromiumFields.nullableText,
    description: 'The installed web app the visit happened in.',
  },
  source: {
    ...chromiumFields.integer,
    description:
      'Where the visit came from, as Chromium’s visit_source numbers it: 0 sync from another device, 1 browsed on this device, 2 an extension, 3 imported from Firefox, 4 from Internet Explorer, 5 from Safari, 6 an actor (in Chrome, Gemini browsing for the user), 7 an operating system migration. Dia writes 6 on the visits it imported from Arc.',
  },
  contextFlags: context(
    'Bits of what the browser noted as the visit happened (context_annotation_flags).',
  ),
  contextDurationSinceLastVisitMicros: context(
    'Microseconds since the previous visit to the URL; -1000000 (minus one second) when the browser did not know it.',
  ),
  contextPageEndReason: context(
    'Why the page ended, as Chromium’s page_load_metrics PageEndReason numbers it; 0 when it had not ended.',
  ),
  contextTotalForegroundDurationMicros: context(
    'Microseconds the page was in the foreground; -1000000 (minus one second) when the browser did not know it.',
  ),
  contextBrowserType: context(
    'The kind of window, as Chromium’s VisitContextAnnotations::BrowserType numbers it; seen: 1 (a tabbed window) and 2 (a popup).',
  ),
  contextWindowId: context('The window the visit happened in.'),
  contextTabId: context('The tab the visit happened in.'),
  contextTaskId: taskId('The task the visit belongs to.'),
  contextRootTaskId: taskId('The first task of the visit’s chain.'),
  contextParentTaskId: taskId('The task the visit’s task came from.'),
  contextResponseCode: context('The HTTP status code of the page.'),
} as const;

export class HistoryVisitsStream extends ChromiumStream<
  typeof properties,
  Profiled<HistoryVisit>
> {
  readonly name = 'historyVisits';
  readonly store = 'history';
  readonly description =
    'Each visit in the History of a profile: when, how it began, and what led to it. An import’s dates select visits.';
  readonly properties = properties;
  readonly primaryKey = ['profileId', 'id'];

  // expires: whether the browser removes old history.
  constructor(expires: boolean) {
    super(expires ? ({ row }) => row.expiresAt : undefined);
  }

  protected rows(scan: ChromiumScan) {
    return scan.history.visits();
  }

  protected record({
    profileId,
    row,
  }: Profiled<HistoryVisit>): RecordDraft<typeof properties> {
    const { context } = row;
    return {
      profileId,
      id: row.id,
      urlId: row.urlId,
      visitedAt: row.visitedAt,
      fromVisitId: row.fromVisitId,
      externalReferrerUrl: row.externalReferrerUrl,
      transition: row.transition,
      transitionType: row.transitionType,
      transitionQualifiers: row.transitionQualifiers,
      segmentId: row.segmentId,
      durationMicros: row.durationMicros,
      incrementedOmniboxTypedScore: row.incrementedOmniboxTypedScore,
      openerVisitId: row.openerVisitId,
      originatorCacheGuid: row.originatorCacheGuid,
      originatorVisitId: row.originatorVisitId,
      originatorFromVisitId: row.originatorFromVisitId,
      originatorOpenerVisitId: row.originatorOpenerVisitId,
      knownToSync: row.knownToSync,
      considerForNtpMostVisited: row.considerForNtpMostVisited,
      visitedLinkId: row.visitedLinkId,
      appId: row.appId,
      source: row.source,
      contextFlags: context?.flags ?? null,
      contextDurationSinceLastVisitMicros:
        context?.durationSinceLastVisitMicros ?? null,
      contextPageEndReason: context?.pageEndReason ?? null,
      contextTotalForegroundDurationMicros:
        context?.totalForegroundDurationMicros ?? null,
      contextBrowserType: context?.browserType ?? null,
      contextWindowId: context?.windowId ?? null,
      contextTabId: context?.tabId ?? null,
      contextTaskId: context?.taskId ?? null,
      contextRootTaskId: context?.rootTaskId ?? null,
      contextParentTaskId: context?.parentTaskId ?? null,
      contextResponseCode: context?.responseCode ?? null,
    };
  }
}
