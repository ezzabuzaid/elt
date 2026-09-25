export { MacOSDocumentParser } from './parsers/macos-document-parser.ts';
export { MessagesUnavailableError } from './platform/macos/chat-database.ts';
export {
  CalendarUnavailableError,
  EventKitChangingError,
  RemindersUnavailableError,
} from './platform/macos/eventkit.ts';
export {
  AppleCalendarSource,
  type CalendarAttachment,
  type CalendarAttachmentFetcher,
  CalendarIcsUnavailableError,
} from './sources/apple-calendar/apple-calendar-source.ts';
export { AppleMessagesSource } from './sources/apple-messages/apple-messages-source.ts';
export { AppleNotesSource } from './sources/apple-notes/apple-notes-source.ts';
export { NotesUnavailableError } from './sources/apple-notes/apple-notes-stream.ts';
export { AppleRemindersSource } from './sources/apple-reminders/apple-reminders-source.ts';
