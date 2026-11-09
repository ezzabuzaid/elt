export { StoreUnavailableError } from '@eltjs/sdk-macos-app-database';
export type { Call } from './call.ts';
export {
  type CallTimers,
  CallHistorySnapshot,
  type EmergencyMediaItem,
  type Participant,
  type SaintDavidsCount,
} from './call-history-snapshot.ts';
export {
  CallHistoryStore,
  callHistoryStorePath,
} from './call-history-store.ts';
export { CallHistorySchemaError } from './errors.ts';
