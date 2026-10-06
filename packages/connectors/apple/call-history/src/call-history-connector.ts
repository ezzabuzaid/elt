import { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import type { Choice } from '@workspace/connector-apple-connector/choice';
import { AppleCallHistorySource } from '@workspace/source-apple-call-history/apple-call-history-source';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

export default class CallHistoryConnector extends AppleConnector {
  readonly datedBy = 'call date';
  readonly fullDiskAccess = true;
  // One small store of every call on this Mac; a date range is the only
  // narrowing.
  protected readonly choices: readonly Choice[] = [];
  // Reading the calls opens the protected call history store.
  protected override readonly probe = 'calls';
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(): string {
    return 'No app needs to be open: macOS keeps the calls from Phone, FaceTime and your iPhone in one store.';
  }

  protected source(scope: ImportScope) {
    return new AppleCallHistorySource(undefined, scope);
  }
}
