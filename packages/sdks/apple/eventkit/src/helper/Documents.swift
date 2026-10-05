import AppKit
import EventKit
import Foundation

// Raw EventKit values, one document per native object. Dates are epoch
// milliseconds (timeIntervalSince1970 * 1000); `…Day` strings are local
// calendar dates. Node builds row ids, ISO timestamps and positions from these.
// A nil optional is left out of the JSON and reads as null.

struct AccountDocument: Encodable {
  let type = "account"
  let id: String
  let name: String
  let sourceType: Int
  let isDelegate: Bool

  init(_ source: EKSource) {
    id = source.sourceIdentifier
    name = source.title
    sourceType = source.sourceType.rawValue
    isDelegate = source.isDelegate
  }
}

struct CalendarDocument: Encodable {
  let type = "calendar"
  let id: String
  let accountId: String?
  let name: String
  let calendarType: Int
  let writable: Bool
  let subscribed: Bool
  let immutable: Bool
  let color: [Double]?
  let supportedAvailabilities: UInt
  let allowedEntityTypes: UInt
  // Calendar.app's calendar description; read for event calendars only.
  let notes: String?
  // Inside the request's account and collection scope.
  let selected: Bool

  init(_ calendar: EKCalendar, notes: String?, selected: Bool) throws {
    id = calendar.calendarIdentifier
    accountId = calendar.source?.sourceIdentifier
    name = calendar.title
    calendarType = calendar.type.rawValue
    writable = calendar.allowsContentModifications
    subscribed = calendar.isSubscribed
    immutable = calendar.isImmutable
    color = try calendar.color.map(srgb)
    supportedAvailabilities = calendar.supportedEventAvailabilities.rawValue
    allowedEntityTypes = calendar.allowedEntityTypes.rawValue
    self.notes = notes
    self.selected = selected
  }
}

private func srgb(_ color: NSColor) throws -> [Double] {
  guard let rgb = color.usingColorSpace(.sRGB) else {
    throw HelperError("EventKit calendar color cannot be converted to sRGB")
  }
  let components = [rgb.redComponent, rgb.greenComponent, rgb.blueComponent, rgb.alphaComponent]
    .map(Double.init)
  guard components.allSatisfy({ (0...1).contains($0) }) else {
    throw HelperError("EventKit returned an out-of-range color component")
  }
  return components
}

struct LocationDocument: Encodable {
  let title: String?
  let latitude: Double?
  let longitude: Double?
  let radius: Double

  init?(_ location: EKStructuredLocation?) {
    guard let location else { return nil }
    title = location.title
    latitude = location.geoLocation?.coordinate.latitude
    longitude = location.geoLocation?.coordinate.longitude
    radius = location.radius
  }
}

struct ParticipantDocument: Encodable {
  let name: String?
  let url: String
  let status: Int
  let role: Int
  let participantType: Int
  let isCurrentUser: Bool

  init(_ participant: EKParticipant) {
    name = participant.name
    url = participant.url.absoluteString
    status = participant.participantStatus.rawValue
    role = participant.participantRole.rawValue
    participantType = participant.participantType.rawValue
    isCurrentUser = participant.isCurrentUser
  }
}

struct AlarmDocument: Encodable {
  let alarmType: Int
  let relativeOffset: Double
  let absoluteMs: Double?
  let emailAddress: String?
  let soundName: String?
  let proximity: Int
  let location: LocationDocument?

  init(_ alarm: EKAlarm) {
    alarmType = alarm.type.rawValue
    relativeOffset = alarm.relativeOffset
    absoluteMs = alarm.absoluteDate.map(milliseconds)
    emailAddress = alarm.emailAddress
    soundName = alarm.soundName
    proximity = alarm.proximity.rawValue
    location = LocationDocument(alarm.structuredLocation)
  }
}

struct RecurrenceRuleDocument: Encodable {
  struct End: Encodable {
    let endMs: Double?
    let occurrenceCount: Int
  }

  struct DayOfWeek: Encodable {
    let day: Int
    let weekNumber: Int
  }

  let calendarIdentifier: String?
  let frequency: Int
  let interval: Int
  let firstDayOfWeek: Int
  let end: End?
  let daysOfTheWeek: [DayOfWeek]
  let daysOfTheMonth: [Int]
  let daysOfTheYear: [Int]
  let weeksOfTheYear: [Int]
  let monthsOfTheYear: [Int]
  let setPositions: [Int]

  init(_ rule: EKRecurrenceRule) {
    calendarIdentifier = rule.calendarIdentifier
    frequency = rule.frequency.rawValue
    interval = rule.interval
    firstDayOfWeek = rule.firstDayOfTheWeek
    end = rule.recurrenceEnd.map {
      End(endMs: $0.endDate.map(milliseconds), occurrenceCount: $0.occurrenceCount)
    }
    daysOfTheWeek = (rule.daysOfTheWeek ?? []).map {
      DayOfWeek(day: $0.dayOfTheWeek.rawValue, weekNumber: $0.weekNumber)
    }
    let integers = { (values: [NSNumber]?) in (values ?? []).map(\.intValue) }
    daysOfTheMonth = integers(rule.daysOfTheMonth)
    daysOfTheYear = integers(rule.daysOfTheYear)
    weeksOfTheYear = integers(rule.weeksOfTheYear)
    monthsOfTheYear = integers(rule.monthsOfTheYear)
    setPositions = integers(rule.setPositions)
  }
}

func milliseconds(_ date: Date) -> Double {
  date.timeIntervalSince1970 * 1000
}

// yyyy-MM-dd in the process's default time zone, as Calendar shows all-day dates.
private let dayFormatter: DateFormatter = {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.calendar = Calendar(identifier: .gregorian)
  formatter.dateFormat = "yyyy-MM-dd"
  return formatter
}()

func day(_ date: Date) -> String {
  dayFormatter.timeZone = NSTimeZone.default
  return dayFormatter.string(from: date)
}

// Every account, and every calendar of the entity marked by the request's scope.
func writeAccountsAndCalendars(
  _ request: ReadRequest,
  store: EKEventStore,
  lines: Lines,
  notes: (EKCalendar) throws -> String? = { _ in nil }
) throws -> [EKCalendar] {
  for source in store.sources { try lines.write(AccountDocument(source)) }
  var selected: [EKCalendar] = []
  for calendar in store.calendars(for: request.entity.type) {
    let inScope = request.selects(calendar)
    if inScope { selected.append(calendar) }
    try lines.write(CalendarDocument(calendar, notes: try notes(calendar), selected: inScope))
  }
  return selected
}
