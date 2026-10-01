// What an import of one app covers: native account and collection IDs (Notes
// folders, Mail mailboxes, Messages chats, Contacts containers, Calendar
// calendars, Reminders lists) and a date range, startAt inclusive and endAt
// exclusive. An absent key means all.
export type ImportScope = {
  readonly accountIds?: readonly string[];
  readonly collectionIds?: readonly string[];
  readonly startAt?: string;
  readonly endAt?: string;
};
