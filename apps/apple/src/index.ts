export { MacOSDocumentParser } from './parsers/macos-document-parser.ts';
export {
  CalendarUnavailableError,
  RemindersUnavailableError,
} from './platform/macos/eventkit.ts';
export {
  AppleCalendarSource,
  type CalendarAttachment,
  type CalendarAttachmentFetcher,
  CalendarIcsUnavailableError,
} from './sources/apple-calendar/apple-calendar-source.ts';
export { AppleNotesSource } from './sources/apple-notes/apple-notes-source.ts';
export { NotesUnavailableError } from './sources/apple-notes/apple-notes-stream.ts';
export { AppleRemindersSource } from './sources/apple-reminders/apple-reminders-source.ts';
