import EventKit
import Foundation

struct DateComponentsDocument: Encodable {
  let calendarIdentifier: String?
  let timeZone: String?
  let era: Int?
  let year: Int?
  let month: Int?
  let day: Int?
  let hour: Int?
  let minute: Int?
  let second: Int?
  let nanosecond: Int?
  let weekday: Int?
  let weekdayOrdinal: Int?
  let quarter: Int?
  let weekOfMonth: Int?
  let weekOfYear: Int?
  let yearForWeekOfYear: Int?
  // Absent before macOS 15.
  let dayOfYear: Int?
  let leapMonth: Bool
  // Absent where NSDateComponents has no isRepeatedDay.
  let repeatedDay: Bool?

  // Reads NSDateComponents by selector, so a component this macOS lacks stays
  // absent instead of following the SDK the helper was built with.
  init?(_ value: DateComponents?) {
    guard let value else { return nil }
    let components = value as NSDateComponents
    let component = { (name: String) -> Int? in
      guard components.responds(to: NSSelectorFromString(name)),
        let number = components.value(forKey: name) as? Int, number != NSDateComponentUndefined
      else { return nil }
      return number
    }
    calendarIdentifier = (components.calendar as NSCalendar?)?.calendarIdentifier.rawValue
    timeZone = components.timeZone?.identifier
    era = component("era")
    year = component("year")
    month = component("month")
    day = component("day")
    hour = component("hour")
    minute = component("minute")
    second = component("second")
    nanosecond = component("nanosecond")
    weekday = component("weekday")
    weekdayOrdinal = component("weekdayOrdinal")
    quarter = component("quarter")
    weekOfMonth = component("weekOfMonth")
    weekOfYear = component("weekOfYear")
    yearForWeekOfYear = component("yearForWeekOfYear")
    dayOfYear = component("dayOfYear")
    leapMonth = components.isLeapMonth
    repeatedDay =
      components.responds(to: NSSelectorFromString("isRepeatedDay"))
      ? components.value(forKey: "repeatedDay") as? Bool : nil
  }
}

struct ReminderDocument: Encodable {
  let type = "reminder"
  let id: String
  let listId: String
  let externalId: String?
  let name: String?
  let body: String?
  let location: String?
  let url: String?
  let timeZone: String?
  let createdMs: Double?
  let modifiedMs: Double?
  let completed: Bool
  let completedMs: Double?
  let priority: Int
  let start: DateComponentsDocument?
  let due: DateComponentsDocument?
  let attendees: [ParticipantDocument]
  let alarms: [AlarmDocument]
  let recurrenceRules: [RecurrenceRuleDocument]

  init(_ reminder: EKReminder) throws {
    guard let listId = reminder.calendar?.calendarIdentifier, !reminder.calendarItemIdentifier.isEmpty
    else { throw HelperError("EventKit reminder has no list or item identifier") }
    id = reminder.calendarItemIdentifier
    self.listId = listId
    externalId = reminder.calendarItemExternalIdentifier
    name = reminder.title
    body = reminder.notes
    location = reminder.location
    url = reminder.url?.absoluteString
    timeZone = reminder.timeZone?.identifier
    createdMs = reminder.creationDate.map(milliseconds)
    modifiedMs = reminder.lastModifiedDate.map(milliseconds)
    completed = reminder.isCompleted
    completedMs = reminder.completionDate.map(milliseconds)
    priority = reminder.priority
    start = DateComponentsDocument(reminder.startDateComponents)
    due = DateComponentsDocument(reminder.dueDateComponents)
    attendees = (reminder.attendees ?? []).map(ParticipantDocument.init)
    alarms = (reminder.alarms ?? []).map(AlarmDocument.init)
    recurrenceRules = (reminder.recurrenceRules ?? []).map(RecurrenceRuleDocument.init)
  }
}

func readReminders(_ request: ReadRequest, store: EKEventStore, lines: Lines) throws {
  let lists = try writeAccountsAndCalendars(request, store: store, lines: lines)
  if request.scoped && lists.isEmpty { return }
  // Unscoped reads pass nil: every list, completed reminders included.
  let predicate = store.predicateForReminders(in: request.scoped ? lists : nil)
  for reminder in try fetch(predicate, store: store) {
    try lines.write(try ReminderDocument(reminder))
  }
}

// A nil result means a failed fetch, not an empty collection to publish.
private func fetch(_ predicate: NSPredicate, store: EKEventStore) throws -> [EKReminder] {
  let done = DispatchSemaphore(value: 0)
  var reminders: [EKReminder]?
  let request = store.fetchReminders(matching: predicate) {
    reminders = $0
    done.signal()
  }
  guard done.wait(timeout: .now() + 60) == .success else {
    store.cancelFetchRequest(request)
    throw HelperError("EventKit reminder fetch timed out")
  }
  guard let reminders else { throw HelperError("EventKit reminder query failed") }
  return reminders
}
