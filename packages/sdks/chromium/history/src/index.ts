export { StoreUnavailableError } from '@workspace/sdk-macos-app-database';
export {
  type ChromiumHistory,
  type HistoryDownload,
  type HistorySearchTerm,
  type HistoryUrl,
  type HistoryVisit,
  type VisitContext,
  chromiumHistoryLastWrite,
  chromiumHistoryVersion,
  openChromiumHistory,
} from './chromium-history.ts';
export {
  type TransitionQualifier,
  type TransitionType,
  transitionQualifierNames,
  transitionTypes,
} from './page-transition.ts';
