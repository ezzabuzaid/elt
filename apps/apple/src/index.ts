export { MacOSDocumentParser } from './parsers/macos-document-parser.ts';
export {
  ContactsSchemaError,
  ContactsUnavailableError,
} from './platform/macos/address-book.ts';
export { MessagesUnavailableError } from './platform/macos/chat-database.ts';
export {
  CalendarUnavailableError,
  EventKitChangingError,
  RemindersUnavailableError,
} from './platform/macos/eventkit.ts';
export {
  NotesSchemaError,
  NotesUnavailableError,
} from './platform/macos/note-store.ts';
export {
  AppleCalendarSource,
  type CalendarAttachment,
  type CalendarAttachmentFetcher,
  CalendarIcsUnavailableError,
} from './sources/apple-calendar/apple-calendar-source.ts';
export { googleCalendarAttachments } from './sources/apple-calendar/google-calendar-attachments.ts';
export { AppleContactsSource } from './sources/apple-contacts/apple-contacts-source.ts';
export { AppleMessagesSource } from './sources/apple-messages/apple-messages-source.ts';
export { AppleNotesSource } from './sources/apple-notes/apple-notes-source.ts';
export { AppleRemindersSource } from './sources/apple-reminders/apple-reminders-source.ts';
